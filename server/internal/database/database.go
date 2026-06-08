package database

import (
	"context"
	"fmt"
	"time"

	"firmatek/server/internal/config"
	"github.com/jackc/pgx/v5/pgxpool"
)

type DB struct {
	Pool *pgxpool.Pool
}

func Connect(cfg *config.DatabaseConfig) (*DB, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	poolConfig, err := pgxpool.ParseConfig(cfg.DSN())
	if err != nil {
		return nil, fmt.Errorf("błąd parsowania DSN: %w", err)
	}

	poolConfig.MaxConns = 25
	poolConfig.MinConns = 5
	poolConfig.MaxConnLifetime = 1 * time.Hour
	poolConfig.MaxConnIdleTime = 30 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("błąd połączenia z bazą: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("baza niedostępna: %w", err)
	}

	db := &DB{Pool: pool}
	if err := db.migrate(ctx); err != nil {
		return nil, fmt.Errorf("błąd migracji: %w", err)
	}

	fmt.Println("[DB] Połączono z PostgreSQL i wykonano migracje")
	return db, nil
}

func (db *DB) migrate(ctx context.Context) error {
	migrations := []string{
		`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`,

		`CREATE TABLE IF NOT EXISTS users (
			id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			username      VARCHAR(50)  UNIQUE NOT NULL,
			display_name  VARCHAR(100) NOT NULL,
			password_hash VARCHAR(255) NOT NULL,
			avatar_color  VARCHAR(7)   NOT NULL DEFAULT '#6366f1',
			created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
			last_seen     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
		)`,

		`CREATE TABLE IF NOT EXISTS channels (
			id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			name       VARCHAR(100) NOT NULL,
			is_direct  BOOLEAN      NOT NULL DEFAULT FALSE,
			created_by UUID REFERENCES users(id),
			created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
		)`,

		`CREATE TABLE IF NOT EXISTS channel_members (
			channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
			user_id    UUID REFERENCES users(id)    ON DELETE CASCADE,
			joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (channel_id, user_id)
		)`,

		`CREATE TABLE IF NOT EXISTS messages (
			id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			channel_id UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
			sender_id  UUID        NOT NULL REFERENCES users(id),
			type       VARCHAR(20) NOT NULL DEFAULT 'text',
			content    TEXT        NOT NULL,
			metadata   JSONB,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			delivered  BOOLEAN     NOT NULL DEFAULT FALSE
		)`,

		`CREATE INDEX IF NOT EXISTS idx_messages_channel_created
			ON messages(channel_id, created_at DESC)`,

		`CREATE INDEX IF NOT EXISTS idx_channel_members_user
			ON channel_members(user_id)`,

		// Pełnotekstowe wyszukiwanie wiadomości (po polsku i ogólne)
		`CREATE INDEX IF NOT EXISTS idx_messages_content_search
			ON messages USING GIN(to_tsvector('simple', content))`,
	}

	for _, sql := range migrations {
		if _, err := db.Pool.Exec(ctx, sql); err != nil {
			return fmt.Errorf("migracja nieudana [%.60s...]: %w", sql, err)
		}
	}
	return nil
}

func (db *DB) Close() {
	db.Pool.Close()
}

func (db *DB) GetPool() *pgxpool.Pool {
	return db.Pool
}
