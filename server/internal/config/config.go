package config

import (
	"fmt"
	"os"
)

type Config struct {
	Server      ServerConfig
	Database    DatabaseConfig
	Redis       RedisConfig
	JWT         JWTConfig
	LDAP        LDAPConfig
	App         AppConfig
	NotifyToken string
}

type ServerConfig struct{ Port string }
type DatabaseConfig struct{ Host, Port, Name, User, Password string }
type RedisConfig struct{ Host, Port, Password string }
type JWTConfig struct{ Secret string }

type LDAPConfig struct {
	Enabled            bool
	URL                string
	Domain             string
	BaseDN             string
	BindUser           string
	BindPassword       string
	UserFilter         string
	EnableRegistration bool
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
		},
		App:         AppConfig{Name: getEnv("APP_NAME", "Firmatek")},
		NotifyToken: getEnv("NOTIFY_TOKEN", ""),
	}

	if cfg.JWT.Secret == "change_this_in_production" {
		fmt.Println("[WARN] JWT_SECRET nie jest ustawiony!")
	}
	if cfg.NotifyToken == "" {
		fmt.Println("[WARN] NOTIFY_TOKEN nie jest ustawiony – endpoint /api/notify wyłączony")
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
