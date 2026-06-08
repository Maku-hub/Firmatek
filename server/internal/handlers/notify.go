package handlers

import (
	"context"
	"net/http"
	"strings"
	"time"

	"firmatek/server/internal/models"

	"github.com/gin-gonic/gin"
)

// NotifyRequest – payload dla endpointu powiadomień CI/CD
type NotifyRequest struct {
	Channel string `json:"channel" binding:"required"` // nazwa kanału lub ID
	Message string `json:"message" binding:"required"`
	// Opcjonalne pola dla lepszego formatowania
	Title  string `json:"title"`   // np. "✅ Deploy zakończony"
	Level  string `json:"level"`   // info | success | warning | error
	Footer string `json:"footer"`  // np. "Pipeline #123 | main"
}

// Notify – endpoint do wysyłania wiadomości z zewnętrznych systemów
// POST /api/notify
// Header: X-Notify-Token: <NOTIFY_TOKEN z .env>
func (h *Handlers) Notify(c *gin.Context) {
	// Sprawdź token powiadomień
	token := c.GetHeader("X-Notify-Token")
	if token == "" {
		token = c.Query("token")
	}
	expected := h.cfg.NotifyToken
	if expected == "" || token != expected {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "nieprawidłowy token powiadomień"})
		return
	}

	var req NotifyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	bgCtx := context.Background()

	// Znajdź kanał po nazwie lub ID
	channelID, err := h.resolveChannel(bgCtx, req.Channel)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "kanał nie znaleziony: " + req.Channel})
		return
	}

	// Zbuduj treść wiadomości
	content := buildNotifyMessage(req)

	// Zapisz wiadomość w bazie jako nadaną przez "system"
	systemUserID := h.getOrCreateSystemUser(bgCtx)

	var msgID string
	_ = h.db.Pool.QueryRow(bgCtx, `
		INSERT INTO messages (channel_id, sender_id, type, content)
		VALUES ($1, $2, 'system', $3) RETURNING id`,
		channelID, systemUserID, content,
	).Scan(&msgID)

	// Wyślij do wszystkich online członków kanału przez WebSocket
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

// resolveChannel – szuka kanału po ID lub nazwie
func (h *Handlers) resolveChannel(ctx context.Context, nameOrID string) (string, error) {
	// Najpierw spróbuj jako ID
	var id string
	err := h.db.Pool.QueryRow(ctx,
		`SELECT id FROM channels WHERE id=$1 OR name=$2 LIMIT 1`,
		nameOrID, nameOrID,
	).Scan(&id)
	return id, err
}

// getOrCreateSystemUser – zwraca ID użytkownika systemowego
func (h *Handlers) getOrCreateSystemUser(ctx context.Context) string {
	var id string
	err := h.db.Pool.QueryRow(ctx,
		`SELECT id FROM users WHERE username='system' LIMIT 1`).Scan(&id)
	if err == nil {
		return id
	}
	// Utwórz
	_ = h.db.Pool.QueryRow(ctx, `
		INSERT INTO users (username, display_name, password_hash, avatar_color)
		VALUES ('system', '🤖 System', 'SYSTEM_NO_LOGIN', '#374151')
		ON CONFLICT (username) DO UPDATE SET display_name=EXCLUDED.display_name
		RETURNING id`).Scan(&id)
	return id
}
