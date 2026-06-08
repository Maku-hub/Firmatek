package auth

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

const UserIDKey = "userID"
const UsernameKey = "username"
const DisplayNameKey = "displayName"

func Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		token := extractToken(c)
		if token == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "brak tokenu autoryzacyjnego"})
			c.Abort()
			return
		}
		claims, err := ValidateToken(token)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "token wygasł lub jest nieprawidłowy"})
			c.Abort()
			return
		}
		c.Set(UserIDKey, claims.UserID)
		c.Set(UsernameKey, claims.Username)
		c.Set(DisplayNameKey, claims.DisplayName)
		c.Next()
	}
}

// WSTokenFromQuery – WebSocket: token w query param
func WSTokenFromQuery() gin.HandlerFunc {
	return func(c *gin.Context) {
		token := c.Query("token")
		if token == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "brak tokenu"})
			c.Abort()
			return
		}
		claims, err := ValidateToken(token)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "nieprawidłowy token"})
			c.Abort()
			return
		}
		c.Set(UserIDKey, claims.UserID)
		c.Set(UsernameKey, claims.Username)
		c.Set(DisplayNameKey, claims.DisplayName)
		c.Next()
	}
}

// DownloadAuth – akceptuje token z nagłówka LUB z query param (dla linków download)
// Zarezerwowane na przyszłość – do pobierania plików z bufora
func DownloadAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		token := extractToken(c)
		if token == "" {
			token = c.Query("token")
		}
		if token == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "brak tokenu"})
			c.Abort()
			return
		}
		claims, err := ValidateToken(token)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "nieprawidłowy token"})
			c.Abort()
			return
		}
		c.Set(UserIDKey, claims.UserID)
		c.Set(UsernameKey, claims.Username)
		c.Set(DisplayNameKey, claims.DisplayName)
		c.Next()
	}
}

func extractToken(c *gin.Context) string {
	header := c.GetHeader("Authorization")
	if header == "" {
		return ""
	}
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
		return ""
	}
	return parts[1]
}
