package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Server      ServerConfig
	Database    DatabaseConfig
	Redis       RedisConfig
	JWT         JWTConfig
	LDAP        LDAPConfig
	App            AppConfig
	TURN           TURNConfig
	NotifyToken    string
	AllowedOrigins []string // empty => allow all (with a warning)
}

type ServerConfig struct{ Port string }
type DatabaseConfig struct{ Host, Port, Name, User, Password string }
type RedisConfig struct{ Host, Port, Password string }
type JWTConfig struct{ Secret string }

// TURNConfig holds settings for issuing time-limited TURN credentials
// (coturn REST API / `use-auth-secret`). Secret empty => STUN only.
type TURNConfig struct {
	Secret string   // shared static-auth-secret (must match coturn)
	URLs   []string // e.g. turn:turn.firma.local:3478
	TTLSec int      // credential lifetime in seconds
}

type LDAPConfig struct {
	Enabled            bool
	URL                string
	Domain             string
	BaseDN             string
	BindUser           string
	BindPassword       string
	UserFilter         string
	EnableRegistration bool
	TLSSkipVerify      bool // skip TLS cert verification (set true only for self-signed AD)
}

type AppConfig struct{ Name string }

func Load() (*Config, error) {
	cfg := &Config{
		Server:   ServerConfig{Port: getEnv("SERVER_PORT", "8080")},
		Database: DatabaseConfig{
			Host: getEnv("DB_HOST", "localhost"), Port: getEnv("DB_PORT", "5432"),
			Name: getEnv("DB_NAME", "firmatek"),   User: getEnv("DB_USER", "firmatek"),
			Password: getEnv("DB_PASSWORD", ""),
		},
		Redis:  RedisConfig{Host: getEnv("REDIS_HOST", "localhost"), Port: getEnv("REDIS_PORT", "6379"), Password: getEnv("REDIS_PASSWORD", "")},
		JWT:    JWTConfig{Secret: getEnv("JWT_SECRET", "change_this_in_production")},
		LDAP: LDAPConfig{
			Enabled:            getEnv("LDAP_ENABLED", "false") == "true",
			URL:                getEnv("LDAP_URL", "ldap://localhost:389"),
			Domain:             getEnv("LDAP_DOMAIN", "firma.local"),
			BaseDN:             getEnv("LDAP_BASE_DN", "DC=firma,DC=local"),
			BindUser:           getEnv("LDAP_BIND_USER", ""),
			BindPassword:       getEnv("LDAP_BIND_PASSWORD", ""),
			UserFilter:         getEnv("LDAP_USER_FILTER", "(sAMAccountName=%s)"),
			EnableRegistration: getEnv("ENABLE_REGISTRATION", "true") == "true",
			TLSSkipVerify:      getEnv("LDAP_TLS_SKIP_VERIFY", "false") == "true",
		},
		App: AppConfig{Name: getEnv("APP_NAME", "Firmatek")},
		TURN: TURNConfig{
			Secret: getEnv("TURN_SECRET", ""),
			URLs:   parseCSV(getEnv("TURN_URLS", "")),
			TTLSec: getEnvInt("TURN_TTL", 3600),
		},
		NotifyToken:    getEnv("NOTIFY_TOKEN", ""),
		AllowedOrigins: parseCSV(getEnv("ALLOWED_ORIGINS", "")),
	}

	// A weak or placeholder JWT secret lets anyone forge tokens, so refuse to
	// start rather than only warning.
	if len(cfg.JWT.Secret) < 32 || strings.HasPrefix(strings.ToLower(cfg.JWT.Secret), "change") {
		return nil, fmt.Errorf("JWT_SECRET is missing, too short (<32 chars), or still a placeholder – set a strong random value, e.g. `openssl rand -hex 32`")
	}
	if cfg.NotifyToken == "" {
		fmt.Println("[WARN] NOTIFY_TOKEN is not set – the /api/notify endpoint is disabled")
	}
	return cfg, nil
}

func (c *DatabaseConfig) DSN() string {
	return fmt.Sprintf("host=%s port=%s dbname=%s user=%s password=%s sslmode=disable",
		c.Host, c.Port, c.Name, c.User, c.Password)
}
func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" { return val }
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if val := os.Getenv(key); val != "" {
		if n, err := strconv.Atoi(val); err == nil {
			return n
		}
	}
	return fallback
}

// parseCSV splits a comma-separated string into trimmed, non-empty values.
func parseCSV(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
