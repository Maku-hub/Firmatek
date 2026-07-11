package handlers

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"net/http"
	"time"

	"firmatek/server/internal/auth"

	"github.com/gin-gonic/gin"
)

// GetTurnCredentials issues short-lived TURN credentials using the coturn REST
// API scheme (`use-auth-secret`): the username is "<expiry-unix>:<userID>" and
// the password is base64(HMAC-SHA1(static-auth-secret, username)). This avoids
// shipping a long-lived static TURN credential in the client.
//
// GET /api/turn-credentials  (JWT-protected)
func (h *Handlers) GetTurnCredentials(c *gin.Context) {
	userID := c.GetString(auth.UserIDKey)

	// Always advertise a public STUN server so basic NAT traversal works even
	// when no TURN relay is configured.
	iceServers := []gin.H{
		{"urls": "stun:stun.l.google.com:19302"},
	}

	if h.cfg.TURN.Secret != "" && len(h.cfg.TURN.URLs) > 0 {
		ttl := h.cfg.TURN.TTLSec
		if ttl <= 0 {
			ttl = 3600
		}
		expiry := time.Now().Add(time.Duration(ttl) * time.Second).Unix()
		username := fmt.Sprintf("%d:%s", expiry, userID)

		mac := hmac.New(sha1.New, []byte(h.cfg.TURN.Secret))
		mac.Write([]byte(username))
		credential := base64.StdEncoding.EncodeToString(mac.Sum(nil))

		iceServers = append(iceServers, gin.H{
			"urls":       h.cfg.TURN.URLs,
			"username":   username,
			"credential": credential,
		})
	}

	c.JSON(http.StatusOK, gin.H{"ice_servers": iceServers})
}
