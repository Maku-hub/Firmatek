package main

import (
	"context"
	"errors"
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

// maxBodyBytes caps REST request bodies. Nothing in the API needs more; files
// are sent peer-to-peer and never pass through the server.
const maxBodyBytes = 1 << 20

func main() {
	_ = godotenv.Load()
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	auth.Init(&cfg.JWT)

	db, err := database.Connect(&cfg.Database)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer db.Close()

	redisCache, err := cache.Connect(&cfg.Redis)
	if err != nil {
		log.Fatalf("redis: %v", err)
	}
	defer redisCache.Close()

	wsHub := hub.NewHub(redisCache, db)
	go wsHub.Run()

	h := handlers.New(db, wsHub, cfg)

	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	// Without an explicit list Gin trusts X-Forwarded-For from anyone, which
	// lets clients pick their own address and sidestep the rate limits.
	if err := router.SetTrustedProxies(cfg.TrustedProxies); err != nil {
		log.Fatalf("TRUSTED_PROXIES: %v", err)
	}
	router.Use(gin.Recovery(), requestLogger(), limitBody(maxBodyBytes))

	corsCfg := cors.Config{
		AllowMethods:  []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:  []string{"Origin", "Content-Type", "Authorization", "X-Notify-Token"},
		ExposeHeaders: []string{"Content-Length", "Retry-After"},
		MaxAge:        12 * time.Hour,
	}
	if len(cfg.AllowedOrigins) > 0 {
		corsCfg.AllowOrigins = cfg.AllowedOrigins
	} else {
		corsCfg.AllowAllOrigins = true
		log.Println("config: ALLOWED_ORIGINS not set, accepting requests from any origin")
	}
	router.Use(cors.New(corsCfg))

	router.GET("/health", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })

	// The per-IP limit is generous because a whole office may sit behind one
	// address. Per-account login throttling happens in the Login handler.
	authLimiter := middleware.NewRateLimiter(120, time.Minute, 120)
	notifyLimiter := middleware.NewRateLimiter(120, time.Minute, 30)

	api := router.Group("/api")
	{
		api.GET("/auth/config", h.GetAuthConfig)
		api.POST("/auth/register", middleware.RateLimit(authLimiter), h.Register)
		api.POST("/auth/login", middleware.RateLimit(authLimiter), h.Login)

		// CI/CD notifications use X-Notify-Token instead of a user session.
		api.POST("/notify", middleware.RateLimit(notifyLimiter), h.Notify)

		p := api.Group("", auth.Middleware())
		{
			p.POST("/auth/refresh", h.RefreshToken)
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
		Addr:              fmt.Sprintf(":%s", cfg.Server.Port),
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		log.Printf("%s listening on :%s", cfg.App.Name, cfg.Server.Port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("shutting down")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

// requestLogger logs one line per request. The query string is left out on
// purpose: the WebSocket and notify endpoints accept tokens there, and they
// must not end up in log files.
func requestLogger() gin.HandlerFunc {
	return gin.LoggerWithFormatter(func(p gin.LogFormatterParams) string {
		return fmt.Sprintf("%s | %3d | %10v | %15s | %-7s %s\n",
			p.TimeStamp.Format("2006/01/02 15:04:05"),
			p.StatusCode, p.Latency.Round(time.Microsecond), p.ClientIP, p.Method, p.Request.URL.Path)
	})
}

func limitBody(n int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, n)
		}
		c.Next()
	}
}
