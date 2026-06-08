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

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load()
	cfg, err := config.Load()
	if err != nil { log.Fatalf("Błąd konfiguracji: %v", err) }

	auth.Init(&cfg.JWT)

	db, err := database.Connect(&cfg.Database)
	if err != nil { log.Fatalf("Błąd bazy danych: %v", err) }
	defer db.Close()

	redisCache, err := cache.Connect(&cfg.Redis)
	if err != nil { log.Fatalf("Błąd Redis: %v", err) }
	defer redisCache.Close()

	wsHub := hub.NewHub(redisCache, db)
	go wsHub.Run()

	h := handlers.New(db, wsHub, redisCache, cfg)

	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Recovery(), gin.Logger())
	router.Use(cors.New(cors.Config{
		AllowAllOrigins:  true,
		AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Authorization", "X-Notify-Token"},
		ExposeHeaders:    []string{"Content-Length", "Content-Disposition"},
		AllowCredentials: false,
		MaxAge:           12 * time.Hour,
	}))

	router.GET("/health", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })

	api := router.Group("/api")
	{
		api.GET("/auth/config", h.GetAuthConfig)
		api.POST("/auth/register", h.Register)
		api.POST("/auth/login", h.Login)

		// CI/CD notify – wymaga tylko X-Notify-Token, bez JWT
		api.POST("/notify", h.Notify)

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
		fmt.Printf("[Server] %s uruchomiony na porcie %s\n", cfg.App.Name, cfg.Server.Port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed { log.Fatalf("%v", err) }
	}()
	<-quit
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
