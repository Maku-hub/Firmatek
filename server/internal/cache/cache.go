package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"firmatek/server/internal/config"
	"github.com/redis/go-redis/v9"
)

type Cache struct {
	client *redis.Client
}

func Connect(cfg *config.RedisConfig) (*Cache, error) {
	client := redis.NewClient(&redis.Options{
		Addr:         fmt.Sprintf("%s:%s", cfg.Host, cfg.Port),
		Password:     cfg.Password,
		DB:           0,
		DialTimeout:  5 * time.Second,
		ReadTimeout:  3 * time.Second,
		WriteTimeout: 3 * time.Second,
		PoolSize:     10,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("Redis niedostępny: %w", err)
	}

	fmt.Println("[Cache] Połączono z Redis")
	return &Cache{client: client}, nil
}

// SetUserOnline – oznacza użytkownika jako online (TTL 90s – odświeżany przez heartbeat)
func (c *Cache) SetUserOnline(ctx context.Context, userID string) error {
	return c.client.Set(ctx, onlineKey(userID), "1", 90*time.Second).Err()
}

// SetUserOffline – usuwa flagę online
func (c *Cache) SetUserOffline(ctx context.Context, userID string) error {
	return c.client.Del(ctx, onlineKey(userID)).Err()
}

// IsUserOnline – sprawdza czy użytkownik jest online
func (c *Cache) IsUserOnline(ctx context.Context, userID string) bool {
	val, err := c.client.Exists(ctx, onlineKey(userID)).Result()
	return err == nil && val > 0
}

// GetOnlineUsers – zwraca zbiór online user IDs
func (c *Cache) GetOnlineUsers(ctx context.Context) ([]string, error) {
	keys, err := c.client.Keys(ctx, "online:*").Result()
	if err != nil {
		return nil, err
	}
	users := make([]string, 0, len(keys))
	for _, k := range keys {
		users = append(users, k[7:]) // odetnij "online:"
	}
	return users, nil
}

// EnqueueOfflineMessage – kolejkuje wiadomość dla offline użytkownika
func (c *Cache) EnqueueOfflineMessage(ctx context.Context, userID string, msg interface{}) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	key := offlineQueueKey(userID)
	pipe := c.client.Pipeline()
	pipe.RPush(ctx, key, data)
	pipe.Expire(ctx, key, 7*24*time.Hour) // TTL 7 dni
	_, err = pipe.Exec(ctx)
	return err
}

// DequeueOfflineMessages – pobiera i usuwa wszystkie zakolejkowane wiadomości
func (c *Cache) DequeueOfflineMessages(ctx context.Context, userID string) ([][]byte, error) {
	key := offlineQueueKey(userID)
	pipe := c.client.Pipeline()
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

// RefreshOnlineTTL – przedłuża TTL online (heartbeat co ~60s)
func (c *Cache) RefreshOnlineTTL(ctx context.Context, userID string) error {
	return c.client.Expire(ctx, onlineKey(userID), 90*time.Second).Err()
}

func (c *Cache) Close() error {
	return c.client.Close()
}

func onlineKey(userID string) string {
	return "online:" + userID
}

func offlineQueueKey(userID string) string {
	return "offline_queue:" + userID
}
