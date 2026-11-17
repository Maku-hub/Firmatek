package cache

import (
	"context"
	"fmt"
	"log"
	"time"

	"firmatek/server/internal/config"

	"github.com/redis/go-redis/v9"
)

const (
	offlineQueueTTL = 7 * 24 * time.Hour
	// Older entries are trimmed. History is always available from the
	// database, the queue only exists to push recent events on reconnect.
	offlineQueueMax = 500
)

type Cache struct {
	client *redis.Client
}

func Connect(cfg *config.RedisConfig) (*Cache, error) {
	client := redis.NewClient(&redis.Options{
		Addr:         fmt.Sprintf("%s:%s", cfg.Host, cfg.Port),
		Password:     cfg.Password,
		DialTimeout:  5 * time.Second,
		ReadTimeout:  3 * time.Second,
		WriteTimeout: 3 * time.Second,
		PoolSize:     10,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis unavailable: %w", err)
	}

	log.Println("cache: connected to Redis")
	return &Cache{client: client}, nil
}

// EnqueueOfflineMessage stores an already encoded WebSocket frame for a user
// who is not connected.
func (c *Cache) EnqueueOfflineMessage(ctx context.Context, userID string, data []byte) error {
	key := offlineQueueKey(userID)
	pipe := c.client.TxPipeline()
	pipe.RPush(ctx, key, data)
	pipe.LTrim(ctx, key, -offlineQueueMax, -1)
	pipe.Expire(ctx, key, offlineQueueTTL)
	_, err := pipe.Exec(ctx)
	return err
}

// DequeueOfflineMessages returns and removes all queued frames for a user.
func (c *Cache) DequeueOfflineMessages(ctx context.Context, userID string) ([][]byte, error) {
	key := offlineQueueKey(userID)
	pipe := c.client.TxPipeline()
	lrange := pipe.LRange(ctx, key, 0, -1)
	pipe.Del(ctx, key)
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return nil, err
	}

	raw, err := lrange.Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	result := make([][]byte, len(raw))
	for i, s := range raw {
		result[i] = []byte(s)
	}
	return result, nil
}

func (c *Cache) Close() error {
	return c.client.Close()
}

func offlineQueueKey(userID string) string {
	return "offline_queue:" + userID
}
