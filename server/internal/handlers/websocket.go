package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"slices"
	"strings"
	"unicode/utf8"

	"firmatek/server/internal/auth"
	"firmatek/server/internal/hub"
	"firmatek/server/internal/models"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

const (
	maxMessageChars  = 20000
	maxLanguageChars = 32
	maxFilenameChars = 255
)

func (h *Handlers) WebSocket(c *gin.Context) {
	conn, err := h.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		// Upgrade has already written the HTTP error response.
		return
	}
	client := hub.NewClient(h.hub, conn,
		c.GetString(auth.UserIDKey), c.GetString(auth.UsernameKey), c.GetString(auth.DisplayNameKey),
		h.routeWSMessage)
	h.hub.Register(client)
	go client.WritePump()
	go client.ReadPump()
}

func (h *Handlers) routeWSMessage(client *hub.Client, msg *models.WSMessage) {
	switch msg.Type {
	case models.WSTypeChatMessage:
		h.handleChatMessage(client, msg)
	case models.WSTypeTyping:
		h.handleTyping(client, msg)
	case models.WSTypeRTCOffer, models.WSTypeRTCAnswer, models.WSTypeICECandidate, models.WSTypeRTCDecline:
		if isUUID(msg.TargetID) && msg.TargetID != client.UserID {
			h.hub.SendToUser(msg.TargetID, &models.WSMessage{
				Type:     msg.Type,
				SenderID: client.UserID,
				TargetID: msg.TargetID,
				Payload:  msg.Payload,
			})
		}
	case models.WSTypePing:
		client.Send(&models.WSMessage{Type: models.WSTypePong})
	}
}

type chatPayload struct {
	ChannelID string              `json:"channel_id"`
	ClientID  string              `json:"client_id"`
	Content   string              `json:"content"`
	Type      models.MessageType  `json:"type"`
	Metadata  *models.MessageMeta `json:"metadata"`
}

// handleChatMessage stores a message, acknowledges it to the sending
// connection and fans it out to the channel. A message carrying a client_id
// that was already stored is only acknowledged again, so clients can safely
// resend anything they have no acknowledgement for.
func (h *Handlers) handleChatMessage(client *hub.Client, msg *models.WSMessage) {
	var p chatPayload
	if err := decodePayload(msg.Payload, &p); err != nil {
		client.SendError("invalid chat message")
		return
	}
	if !isUUID(p.ClientID) {
		p.ClientID = ""
	}
	reject := func(text string) { client.SendMessageError(p.ClientID, text) }

	if !h.msgLimiter.Allow(client.UserID) {
		reject("you are sending messages too quickly")
		return
	}
	if p.ChannelID == "" {
		p.ChannelID = msg.ChannelID
	}
	if strings.TrimSpace(p.Content) == "" {
		reject("message is empty")
		return
	}
	if utf8.RuneCountInString(p.Content) > maxMessageChars {
		reject("message is too long")
		return
	}

	// Clients may only post plain text and code. Images and system notices are
	// produced by the server, and accepting them here would let anyone forge a
	// "System" message or embed a remote image that tracks readers.
	var meta *models.MessageMeta
	switch p.Type {
	case "", models.MessageTypeText:
		p.Type = models.MessageTypeText
	case models.MessageTypeCodeSnippet:
		if p.Metadata != nil {
			meta = &models.MessageMeta{
				Language: truncate(p.Metadata.Language, maxLanguageChars),
				Filename: truncate(p.Metadata.Filename, maxFilenameChars),
			}
		}
	default:
		reject("unsupported message type")
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), dbTimeout)
	defer cancel()

	members, err := h.channelMembers(ctx, p.ChannelID)
	if err != nil {
		log.Printf("chat: members of %s: %v", p.ChannelID, err)
		reject("message could not be sent")
		return
	}
	if !slices.Contains(members, client.UserID) {
		reject("you are not a member of this channel")
		return
	}

	var metaJSON []byte
	if meta != nil {
		metaJSON, _ = json.Marshal(meta)
	}
	var clientID any // NULL when the client did not send one
	if p.ClientID != "" {
		clientID = p.ClientID
	}
	out := &models.Message{
		ChannelID: p.ChannelID,
		SenderID:  client.UserID,
		ClientID:  p.ClientID,
		Type:      p.Type,
		Content:   p.Content,
		Metadata:  meta,
		Sender:    &models.User{ID: client.UserID, Username: client.Username, DisplayName: client.DisplayName},
	}
	err = h.db.Pool.QueryRow(ctx, `
		WITH m AS (
			INSERT INTO messages (channel_id, sender_id, type, content, metadata, client_id)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (sender_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
			RETURNING id, created_at
		)
		SELECT m.id, m.created_at, u.avatar_color FROM m JOIN users u ON u.id = $2`,
		p.ChannelID, client.UserID, p.Type, p.Content, metaJSON, clientID,
	).Scan(&out.ID, &out.CreatedAt, &out.Sender.AvatarColor)

	if errors.Is(err, pgx.ErrNoRows) && p.ClientID != "" {
		// Already stored by an earlier attempt whose acknowledgement was lost.
		// The members got it then; only the sender needs to hear about it.
		stored, err := h.storedMessage(ctx, client, p.ClientID)
		if err != nil {
			log.Printf("chat: load resent message %s: %v", p.ClientID, err)
			reject("message could not be saved")
			return
		}
		client.Send(&models.WSMessage{Type: models.WSTypeMessageAck, ChannelID: stored.ChannelID, Payload: stored})
		return
	}
	if err != nil {
		log.Printf("chat: save message in %s: %v", p.ChannelID, err)
		reject("message could not be saved")
		return
	}

	client.Send(&models.WSMessage{Type: models.WSTypeMessageAck, ChannelID: p.ChannelID, Payload: out})
	frame := &models.WSMessage{Type: models.WSTypeChatMessage, ChannelID: p.ChannelID, SenderID: client.UserID, Payload: out}
	for _, id := range members {
		h.hub.SendToUser(id, frame)
	}
}

func (h *Handlers) storedMessage(ctx context.Context, client *hub.Client, clientID string) (*models.Message, error) {
	m := &models.Message{
		SenderID: client.UserID,
		ClientID: clientID,
		Sender:   &models.User{ID: client.UserID, Username: client.Username, DisplayName: client.DisplayName},
	}
	var meta []byte
	err := h.db.Pool.QueryRow(ctx, `
		SELECT m.id, m.channel_id, m.type, m.content, m.metadata, m.created_at, u.avatar_color
		FROM messages m JOIN users u ON u.id = m.sender_id
		WHERE m.sender_id = $1 AND m.client_id = $2`, client.UserID, clientID,
	).Scan(&m.ID, &m.ChannelID, &m.Type, &m.Content, &meta, &m.CreatedAt, &m.Sender.AvatarColor)
	if err != nil {
		return nil, err
	}
	if len(meta) > 0 {
		_ = json.Unmarshal(meta, &m.Metadata)
	}
	return m, nil
}

func (h *Handlers) handleTyping(client *hub.Client, msg *models.WSMessage) {
	var p struct {
		Typing bool `json:"typing"`
	}
	if err := decodePayload(msg.Payload, &p); err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), dbTimeout)
	defer cancel()
	members, err := h.channelMembers(ctx, msg.ChannelID)
	if err != nil || !slices.Contains(members, client.UserID) {
		return
	}
	h.hub.SendToChannel(members, &models.WSMessage{
		Type:      models.WSTypeTyping,
		ChannelID: msg.ChannelID,
		SenderID:  client.UserID,
		Payload:   p,
	}, client.UserID)
}

// decodePayload converts the generically decoded payload into dst.
func decodePayload(payload any, dst any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, dst)
}

func truncate(s string, maxChars int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) <= maxChars {
		return s
	}
	return string([]rune(s)[:maxChars])
}
