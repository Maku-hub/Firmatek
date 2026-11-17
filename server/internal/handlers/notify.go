package handlers

import (
	"context"
	"crypto/subtle"
	"errors"
	"log"
	"net/http"
	"strings"
	"unicode/utf8"

	"firmatek/server/internal/models"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

const systemDisplayName = "System"

// NotifyRequest is the body of POST /api/notify.
type NotifyRequest struct {
	Channel string `json:"channel" binding:"required"` // channel name or ID
	Message string `json:"message" binding:"required"`
	Title   string `json:"title"`  // e.g. "Deploy finished"
	Level   string `json:"level"`  // info | success | warning | error
	Footer  string `json:"footer"` // e.g. "Pipeline #123 | main"
}

// Notify lets CI/CD pipelines and other systems post into a channel. It is
// authenticated with the shared NOTIFY_TOKEN, sent as X-Notify-Token (or
// ?token= for tools that cannot set headers).
func (h *Handlers) Notify(c *gin.Context) {
	if h.cfg.NotifyToken == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "notifications are not enabled on this server"})
		return
	}
	token := c.GetHeader("X-Notify-Token")
	if token == "" {
		token = c.Query("token")
	}
	if subtle.ConstantTimeCompare([]byte(token), []byte(h.cfg.NotifyToken)) != 1 {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid notification token"})
		return
	}

	var req NotifyRequest
	if !bindJSON(c, &req) {
		return
	}
	content := buildNotifyMessage(req)
	if utf8.RuneCountInString(content) > maxMessageChars {
		c.JSON(http.StatusBadRequest, gin.H{"error": "message is too long"})
		return
	}

	ctx := c.Request.Context()
	channelID, err := h.resolveChannel(ctx, strings.TrimSpace(req.Channel))
	if errors.Is(err, pgx.ErrNoRows) {
		c.JSON(http.StatusNotFound, gin.H{"error": "channel not found: " + req.Channel})
		return
	}
	if err != nil {
		serverError(c, "database error", err)
		return
	}

	sender, err := h.systemUser(ctx)
	if err != nil {
		serverError(c, "database error", err)
		return
	}

	msg := &models.Message{
		ChannelID: channelID,
		SenderID:  sender.ID,
		Sender:    &sender,
		Type:      models.MessageTypeSystem,
		Content:   content,
	}
	if err := h.db.Pool.QueryRow(ctx, `
		INSERT INTO messages (channel_id, sender_id, type, content)
		VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
		channelID, sender.ID, msg.Type, content,
	).Scan(&msg.ID, &msg.CreatedAt); err != nil {
		serverError(c, "could not save message", err)
		return
	}

	members, err := h.channelMembers(ctx, channelID)
	if err != nil {
		log.Printf("notify: members of %s: %v", channelID, err)
	}
	frame := &models.WSMessage{Type: models.WSTypeChatMessage, ChannelID: channelID, SenderID: sender.ID, Payload: msg}
	for _, id := range members {
		h.hub.SendToUser(id, frame)
	}

	c.JSON(http.StatusOK, gin.H{"ok": true, "channel_id": channelID, "message_id": msg.ID})
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

// resolveChannel finds a channel by ID or, failing that, by name. Direct
// conversations can only be addressed by ID.
func (h *Handlers) resolveChannel(ctx context.Context, nameOrID string) (string, error) {
	var id string
	if isUUID(nameOrID) {
		err := h.db.Pool.QueryRow(ctx, `SELECT id FROM channels WHERE id=$1`, nameOrID).Scan(&id)
		if !errors.Is(err, pgx.ErrNoRows) {
			return id, err
		}
	}
	err := h.db.Pool.QueryRow(ctx,
		`SELECT id FROM channels WHERE name=$1 AND NOT is_direct ORDER BY created_at LIMIT 1`,
		nameOrID).Scan(&id)
	return id, err
}

// systemUser returns the account that authors notifications, creating it on
// first use. Its password hash is not a valid bcrypt hash, so it cannot log in.
func (h *Handlers) systemUser(ctx context.Context) (models.User, error) {
	u := models.User{Username: systemUsername}
	err := h.db.Pool.QueryRow(ctx, `
		INSERT INTO users (username, display_name, password_hash, avatar_color)
		VALUES ($1, $2, 'SYSTEM_NO_LOGIN', '#374151')
		ON CONFLICT (username) DO UPDATE SET username=EXCLUDED.username
		RETURNING id, display_name, avatar_color`,
		systemUsername, systemDisplayName,
	).Scan(&u.ID, &u.DisplayName, &u.AvatarColor)
	return u, err
}
