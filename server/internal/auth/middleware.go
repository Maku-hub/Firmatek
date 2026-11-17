package auth

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

const (
	UserIDKey      = "userID"
	UsernameKey    = "username"
	DisplayNameKey = "displayName"
)

// Middleware authenticates REST calls with an "Authorization: Bearer" header.
func Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		authenticate(c, bearerToken(c))
	}
}

// WSTokenFromQuery authenticates the WebSocket handshake. Browsers cannot set
// headers on a WebSocket request, so the token travels in ?token=.
func WSTokenFromQuery() gin.HandlerFunc {
	return func(c *gin.Context) {
		authenticate(c, c.Query("token"))
	}
}

func authenticate(c *gin.Context, token string) {
	if token == "" {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing authorization token"})
		return
	}
	claims, err := ValidateToken(token)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "token expired or invalid"})
		return
	}
	c.Set(UserIDKey, claims.UserID)
	c.Set(UsernameKey, claims.Username)
	c.Set(DisplayNameKey, claims.DisplayName)
	c.Next()
}

func bearerToken(c *gin.Context) string {
	scheme, token, ok := strings.Cut(c.GetHeader("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "bearer") {
		return ""
	}
	return strings.TrimSpace(token)
}
