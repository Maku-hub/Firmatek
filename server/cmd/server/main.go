package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"firmatek/server/internal/auth"
	"firmatek/server/internal/cache"
	"firmatek/server/internal/config"
	"firmatek/server/internal/database"
	"firmatek/server/internal/handlers"
	"firmatek/server/internal/hub"
	"firmatek/server/internal/middleware"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load()
	cfg, err := config.Load()
	if err != nil { log.Fatalf("Configuration error: %v", err) }

	auth.Init(&cfg.JWT)

	db, err := database.Connect(&cfg.Database)
	if err != nil { log.Fatalf("Database error: %v", err) }
	defer db.Close()

	redisCache, err := cache.Connect(&cfg.Redis)
	if err != nil { log.Fatalf("Redis error: %v", err) }
	defer redisCache.Close()

	wsHub := hub.NewHub(redisCache, db)
	go wsHub.Run()

	h := handlers.New(db, wsHub, redisCache, cfg)

	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Recovery(), gin.Logger())
	corsCfg := cors.Config{
		AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Authorization", "X-Notify-Token"},
		ExposeHeaders:    []string{"Content-Length", "Content-Disposition"},
		AllowCredentials: false,
		MaxAge:           12 * time.Hour,
	}
	if len(cfg.AllowedOrigins) > 0 {
		corsCfg.AllowOrigins = cfg.AllowedOrigins
	} else {
		corsCfg.AllowAllOrigins = true
		fmt.Println("[WARN] ALLOWED_ORIGINS not set – allowing all origins. Set it to lock down CORS/WebSocket.")
	}
	router.Use(cors.New(corsCfg))

	router.GET("/health", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })

	// Rate limiters. The per-IP auth limiter is deliberately generous because a
	// whole office may share one NAT egress IP; per-account brute-force
	// protection is enforced separately inside the Login handler (keyed by
	// username). The notify limiter curbs pipeline spam.
	authLimiter := middleware.NewRateLimiter(120, time.Minute, 120)
	notifyLimiter := middleware.NewRateLimiter(120, time.Minute, 30)

	api := router.Group("/api")
	{
		api.GET("/auth/config", h.GetAuthConfig)
		api.POST("/auth/register", middleware.RateLimit(authLimiter), h.Register)
		api.POST("/auth/login", middleware.RateLimit(authLimiter), h.Login)

		// CI/CD notify – requires only X-Notify-Token, no JWT
		api.POST("/notify", middleware.RateLimit(notifyLimiter), h.Notify)

		p := api.Group("", auth.Middleware())
		{
			p.GET("/me", h.GetMe)
			p.GET("/users", h.GetUsers)
			p.GET("/channels", h.GetChannels)
			p.POST("/channels", h.CreateChannel)
			p.POST("/channels/direct/:target_id", h.CreateDirectChannel)
			p.GET("/channels/:channel_id/messages", h.GetMessages)
			p.GET("/channels/:channel_id/members", h.GetChannelMembers)
			p.POST("/channels/:channel_id/members", h.AddChannelMember)
			p.DELETE("/channels/:channel_id/leave", h.LeaveChannel)
			p.GET("/messages/search", h.SearchMessages)
			p.GET("/turn-credentials", h.GetTurnCredentials)
		}
	}

	router.GET("/ws", auth.WSTokenFromQuery(), h.WebSocket)

	srv := &http.Server{
		Addr: fmt.Sprintf(":%s", cfg.Server.Port), Handler: router,
		ReadTimeout: 15 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 120 * time.Second,
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		fmt.Printf("[Server] %s started on port %s\n", cfg.App.Name, cfg.Server.Port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed { log.Fatalf("%v", err) }
	}()
	<-quit
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
