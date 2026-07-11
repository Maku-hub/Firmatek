package handlers

import (
	"context"
	"net/http"
	"strings"
	"time"

	"firmatek/server/internal/models"

	"github.com/gin-gonic/gin"
)

// NotifyRequest – payload for the CI/CD notification endpoint
type NotifyRequest struct {
	Channel string `json:"channel" binding:"required"` // channel name or ID
	Message string `json:"message" binding:"required"`
	// Optional fields for nicer formatting
	Title  string `json:"title"`   // e.g. "✅ Deploy finished"
	Level  string `json:"level"`   // info | success | warning | error
	Footer string `json:"footer"`  // e.g. "Pipeline #123 | main"
}

// Notify – endpoint for sending messages from external systems
// POST /api/notify
// Header: X-Notify-Token: <NOTIFY_TOKEN from .env>
func (h *Handlers) Notify(c *gin.Context) {
	// Check the notification token
	token := c.GetHeader("X-Notify-Token")
	if token == "" {
		token = c.Query("token")
	}
	expected := h.cfg.NotifyToken
	if expected == "" || token != expected {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid notification token"})
		return
	}

	var req NotifyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	bgCtx := context.Background()

	// Find the channel by name or ID
	channelID, err := h.resolveChannel(bgCtx, req.Channel)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "channel not found: " + req.Channel})
		return
	}

	// Build the message content
	content := buildNotifyMessage(req)

	// Store the message in the database as sent by "system"
	systemUserID := h.getOrCreateSystemUser(bgCtx)

	var msgID string
	_ = h.db.Pool.QueryRow(bgCtx, `
		INSERT INTO messages (channel_id, sender_id, type, content)
		VALUES ($1, $2, 'system', $3) RETURNING id`,
		channelID, systemUserID, content,
	).Scan(&msgID)

	// Deliver to all channel members (online via WebSocket, offline via the Redis queue)
	outMsg := &models.WSMessage{
		Type:      models.WSTypeChatMessage,
		ChannelID: channelID,
		SenderID:  systemUserID,
		Payload: &models.Message{
			ID:        msgID,
			ChannelID: channelID,
			SenderID:  systemUserID,
			Sender: &models.User{
				ID:          systemUserID,
				DisplayName: "🤖 System",
				Username:    "system",
				AvatarColor: "#374151",
			},
			Type:      models.MessageTypeSystem,
			Content:   content,
			CreatedAt: time.Now(),
		},
	}

	for _, memberID := range h.getChannelMembers(channelID) {
		h.hub.SendToUser(memberID, outMsg)
	}

	c.JSON(http.StatusOK, gin.H{
		"ok":         true,
		"channel_id": channelID,
		"message_id": msgID,
	})
}

func buildNotifyMessage(req NotifyRequest) string {
	icon := map[string]string{
		"success": "✅",
		"error":   "❌",
		"warning": "⚠️",
		"info":    "ℹ️",
	}[req.Level]
	if icon == "" {
		icon = "🔔"
	}

	var sb strings.Builder
	if req.Title != "" {
		sb.WriteString(icon + " **" + req.Title + "**\n")
	}
	sb.WriteString(req.Message)
	if req.Footer != "" {
		sb.WriteString("\n— " + req.Footer)
	}
	return sb.String()
}

// resolveChannel – looks up a channel by ID or name.
// id is a UUID column, so we compare its text form to avoid a cast error when
// nameOrID is a plain channel name rather than a valid UUID.
func (h *Handlers) resolveChannel(ctx context.Context, nameOrID string) (string, error) {
	var id string
	err := h.db.Pool.QueryRow(ctx,
		`SELECT id FROM channels WHERE id::text=$1 OR name=$1 LIMIT 1`,
		nameOrID,
	).Scan(&id)
	return id, err
}

// getOrCreateSystemUser – returns the system user's ID
func (h *Handlers) getOrCreateSystemUser(ctx context.Context) string {
	var id string
	err := h.db.Pool.QueryRow(ctx,
		`SELECT id FROM users WHERE username='system' LIMIT 1`).Scan(&id)
	if err == nil {
		return id
	}
	// Create it
	_ = h.db.Pool.QueryRow(ctx, `
		INSERT INTO users (username, display_name, password_hash, avatar_color)
		VALUES ('system', '🤖 System', 'SYSTEM_NO_LOGIN', '#374151')
		ON CONFLICT (username) DO UPDATE SET display_name=EXCLUDED.display_name
		RETURNING id`).Scan(&id)
	return id
}
