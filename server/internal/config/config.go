package config

import (
	"fmt"
	"log"
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
	App         AppConfig
	TURN        TURNConfig
	NotifyToken string
	// AllowedOrigins limits CORS and WebSocket origins. Empty allows all.
	AllowedOrigins []string
	// TrustedProxies lists proxy addresses/CIDRs whose X-Forwarded-For header
	// is honoured. Empty means the TCP peer address is always used.
	TrustedProxies []string
}

type ServerConfig struct{ Port string }
type DatabaseConfig struct{ Host, Port, Name, User, Password, SSLMode string }
type RedisConfig struct{ Host, Port, Password string }
type JWTConfig struct{ Secret string }

// TURNConfig holds the coturn `use-auth-secret` settings used to mint
// short-lived TURN credentials. An empty Secret means STUN only.
type TURNConfig struct {
	Secret string
	URLs   []string // e.g. turn:turn.example.local:3478
	TTLSec int
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
	TLSSkipVerify      bool // only for a self-signed AD certificate
}

type AppConfig struct{ Name string }

// RegistrationOpen reports whether users may create local accounts. With LDAP
// enabled every login goes to the directory, so local accounts would be
// unusable and are never offered.
func (c *Config) RegistrationOpen() bool {
	return c.LDAP.EnableRegistration && !c.LDAP.Enabled
}

func Load() (*Config, error) {
	cfg := &Config{
		Server: ServerConfig{Port: getEnv("SERVER_PORT", "8080")},
		Database: DatabaseConfig{
			Host:     getEnv("DB_HOST", "localhost"),
			Port:     getEnv("DB_PORT", "5432"),
			Name:     getEnv("DB_NAME", "firmatek"),
			User:     getEnv("DB_USER", "firmatek"),
			Password: getEnv("DB_PASSWORD", ""),
			SSLMode:  getEnv("DB_SSLMODE", "disable"),
		},
		Redis: RedisConfig{
			Host:     getEnv("REDIS_HOST", "localhost"),
			Port:     getEnv("REDIS_PORT", "6379"),
			Password: getEnv("REDIS_PASSWORD", ""),
		},
		JWT: JWTConfig{Secret: getEnv("JWT_SECRET", "")},
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
		TrustedProxies: parseCSV(getEnv("TRUSTED_PROXIES", "")),
	}

	// A weak or placeholder secret lets anyone forge tokens.
	if len(cfg.JWT.Secret) < 32 || isPlaceholder(cfg.JWT.Secret) {
		return nil, fmt.Errorf("JWT_SECRET is missing, shorter than 32 characters or still a placeholder; generate one with `openssl rand -hex 32`")
	}

	switch {
	case cfg.NotifyToken == "":
		log.Println("config: NOTIFY_TOKEN not set, /api/notify is disabled")
	case len(cfg.NotifyToken) < 16 || isPlaceholder(cfg.NotifyToken):
		log.Println("config: NOTIFY_TOKEN is too short or still a placeholder, /api/notify is disabled")
		cfg.NotifyToken = ""
	}

	if cfg.LDAP.Enabled && cfg.LDAP.EnableRegistration {
		log.Println("config: ENABLE_REGISTRATION is ignored while LDAP_ENABLED=true")
	}
	return cfg, nil
}

func isPlaceholder(s string) bool {
	return strings.HasPrefix(strings.ToLower(s), "change")
}

func (c *DatabaseConfig) DSN() string {
	return fmt.Sprintf("host=%s port=%s dbname=%s user=%s password=%s sslmode=%s",
		quoteDSN(c.Host), quoteDSN(c.Port), quoteDSN(c.Name), quoteDSN(c.User), quoteDSN(c.Password), quoteDSN(c.SSLMode))
}

// quoteDSN quotes a libpq keyword/value so passwords containing spaces or
// quotes do not break the connection string.
func quoteDSN(v string) string {
	v = strings.ReplaceAll(v, `\`, `\\`)
	v = strings.ReplaceAll(v, `'`, `\'`)
	return "'" + v + "'"
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
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
