package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"firmatek/server/internal/auth"
	"firmatek/server/internal/cache"
	"firmatek/server/internal/config"
	"firmatek/server/internal/database"
	"firmatek/server/internal/hub"
	"firmatek/server/internal/models"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"golang.org/x/crypto/bcrypt"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

type Handlers struct {
	db      *database.DB
	hub     *hub.Hub
	cache   *cache.Cache
	cfg     *config.Config
}

func New(db *database.DB, h *hub.Hub, c *cache.Cache, cfg *config.Config) *Handlers {
	return &Handlers{db: db, hub: h, cache: c, cfg: cfg}
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

type RegisterRequest struct {
	Username    string `json:"username" binding:"required,min=3,max=50"`
	DisplayName string `json:"display_name" binding:"required,min=2,max=100"`
	Password    string `json:"password" binding:"required,min=6"`
}

func (h *Handlers) Register(c *gin.Context) {
	// Zablokuj rejestrację jeśli wyłączona lub LDAP włączony bez lokalnych kont
	if !h.cfg.LDAP.EnableRegistration {
		c.JSON(http.StatusForbidden, gin.H{"error": "rejestracja kont lokalnych jest wyłączona – używaj Active Directory"})
		return
	}

	var req RegisterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "błąd serwera"})
		return
	}

	colors := []string{"#6366f1", "#ec4899", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6"}
	color := colors[len(req.Username)%len(colors)]
	bgCtx := context.Background()

	var userID string
	err = h.db.Pool.QueryRow(bgCtx, `
		INSERT INTO users (username, display_name, password_hash, avatar_color)
		VALUES ($1, $2, $3, $4) RETURNING id`,
		strings.ToLower(strings.TrimSpace(req.Username)),
		strings.TrimSpace(req.DisplayName), string(hash), color,
	).Scan(&userID)
	if err != nil {
		if strings.Contains(err.Error(), "unique") {
			c.JSON(http.StatusConflict, gin.H{"error": "login jest już zajęty"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "błąd zapisu"})
		return
	}
	h.ensureGeneralChannel(bgCtx, userID)
	username := strings.ToLower(strings.TrimSpace(req.Username))
	displayName := strings.TrimSpace(req.DisplayName)
	token, _ := auth.GenerateToken(userID, username, displayName)

	newUser := models.User{ID: userID, Username: username, DisplayName: displayName, AvatarColor: color, Online: false}

	// Broadcast do wszystkich – nowy użytkownik w systemie
	h.hub.SendToAll(&models.WSMessage{Type: models.WSTypeUserNew, Payload: newUser})

	c.JSON(http.StatusCreated, gin.H{"token": token, "user_id": userID, "user": newUser})
}

type LoginRequest struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
}

func (h *Handlers) Login(c *gin.Context) {
	var req LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	bgCtx := context.Background()
	username := strings.ToLower(strings.TrimSpace(req.Username))

	// ─── LDAP auth ────────────────────────────────────────────────────────
	if h.cfg.LDAP.Enabled {
		ldapInfo, err := AuthenticateLDAP(&h.cfg.LDAP, req.Username, req.Password)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "nieprawidłowy login lub hasło (AD)"})
			return
		}

		// Auto-utwórz lub pobierz użytkownika z DB
		userID, displayName, avatarColor, err := h.upsertLDAPUser(bgCtx, ldapInfo)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "błąd synchronizacji z AD"})
			return
		}

		_, _ = h.db.Pool.Exec(bgCtx, `UPDATE users SET last_seen=NOW() WHERE id=$1`, userID)
		token, _ := auth.GenerateToken(userID, ldapInfo.Username, displayName)
		c.JSON(http.StatusOK, gin.H{"token": token, "user": models.User{
			ID: userID, Username: ldapInfo.Username, DisplayName: displayName,
			AvatarColor: avatarColor, Online: h.hub.IsOnline(userID),
		}})
		return
	}

	// ─── Lokalna auth ─────────────────────────────────────────────────────
	var user models.User
	var passwordHash string
	err := h.db.Pool.QueryRow(bgCtx, `
		SELECT id, username, display_name, avatar_color, password_hash
		FROM users WHERE username=$1`, username,
	).Scan(&user.ID, &user.Username, &user.DisplayName, &user.AvatarColor, &passwordHash)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "nieprawidłowy login lub hasło"})
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(req.Password)); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "nieprawidłowy login lub hasło"})
		return
	}
	_, _ = h.db.Pool.Exec(bgCtx, `UPDATE users SET last_seen=NOW() WHERE id=$1`, user.ID)
	token, _ := auth.GenerateToken(user.ID, user.Username, user.DisplayName)
	user.Online = h.hub.IsOnline(user.ID)
	c.JSON(http.StatusOK, gin.H{"token": token, "user": user})
}

// GetMe – zwraca dane zalogowanego użytkownika (do auto-login)
func (h *Handlers) GetMe(c *gin.Context) {
	userID := c.GetString(auth.UserIDKey)
	var user models.User
	err := h.db.Pool.QueryRow(context.Background(), `
		SELECT id, username, display_name, avatar_color FROM users WHERE id=$1`, userID,
	).Scan(&user.ID, &user.Username, &user.DisplayName, &user.AvatarColor)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "użytkownik nie znaleziony"})
		return
	}
	user.Online = true
	c.JSON(http.StatusOK, user)
}

// GetAuthConfig – informuje klienta o trybie auth (LDAP vs lokalne + czy rejestracja)
func (h *Handlers) GetAuthConfig(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"ldap_enabled":        h.cfg.LDAP.Enabled,
		"registration_enabled": h.cfg.LDAP.EnableRegistration,
		"app_name":            h.cfg.App.Name,
	})
}

// ─── USERS ────────────────────────────────────────────────────────────────────

func (h *Handlers) GetUsers(c *gin.Context) {
	rows, err := h.db.Pool.Query(context.Background(), `
		SELECT id, username, display_name, avatar_color, last_seen FROM users ORDER BY display_name`)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "błąd bazy"})
		return
	}
	defer rows.Close()
	var users []models.User
	for rows.Next() {
		var u models.User
		if err := rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarColor, &u.LastSeen); err != nil {
			continue
		}
		u.Online = h.hub.IsOnline(u.ID)
		users = append(users, u)
	}
	if users == nil { users = []models.User{} }
	c.JSON(http.StatusOK, users)
}

// ─── CHANNELS ─────────────────────────────────────────────────────────────────

func (h *Handlers) GetChannels(c *gin.Context) {
	userID := c.GetString(auth.UserIDKey)
	rows, err := h.db.Pool.Query(context.Background(), `
		SELECT ch.id, ch.name, ch.is_direct, ch.created_by, ch.created_at
		FROM channels ch
		JOIN channel_members cm ON cm.channel_id=ch.id
		WHERE cm.user_id=$1
		ORDER BY ch.is_direct, ch.name`, userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "błąd bazy"})
		return
	}
	defer rows.Close()
	var channels []models.Channel
	for rows.Next() {
		var ch models.Channel
		if err := rows.Scan(&ch.ID, &ch.Name, &ch.IsDirect, &ch.CreatedBy, &ch.CreatedAt); err != nil {
			continue
		}
		channels = append(channels, ch)
	}
	if channels == nil { channels = []models.Channel{} }
	c.JSON(http.StatusOK, channels)
}

func (h *Handlers) GetChannelMembers(c *gin.Context) {
	channelID := c.Param("channel_id")
	userID := c.GetString(auth.UserIDKey)
	if !h.isMember(context.Background(), channelID, userID) {
		c.JSON(http.StatusForbidden, gin.H{"error": "brak dostępu"})
		return
	}
	rows, err := h.db.Pool.Query(context.Background(), `
		SELECT u.id, u.username, u.display_name, u.avatar_color
		FROM users u JOIN channel_members cm ON cm.user_id=u.id
		WHERE cm.channel_id=$1 ORDER BY u.display_name`, channelID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "błąd bazy"})
		return
	}
	defer rows.Close()
	var members []models.User
	for rows.Next() {
		var u models.User
		if err := rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarColor); err != nil {
			continue
		}
		u.Online = h.hub.IsOnline(u.ID)
		members = append(members, u)
	}
	if members == nil { members = []models.User{} }
	c.JSON(http.StatusOK, members)
}

type CreateChannelRequest struct {
	Name    string   `json:"name" binding:"required,min=1,max=100"`
	Members []string `json:"members"`
}

func (h *Handlers) CreateChannel(c *gin.Context) {
	userID := c.GetString(auth.UserIDKey)
	var req CreateChannelRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	bgCtx := context.Background()
	tx, err := h.db.Pool.Begin(bgCtx)
	if err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": "błąd transakcji"}); return }
	defer tx.Rollback(bgCtx)

	var channelID string
	if err := tx.QueryRow(bgCtx, `INSERT INTO channels (name, created_by) VALUES ($1,$2) RETURNING id`,
		strings.TrimSpace(req.Name), userID).Scan(&channelID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "błąd tworzenia kanału"}); return
	}
	seen := map[string]bool{}
	for _, uid := range append([]string{userID}, req.Members...) {
		if seen[uid] || uid == "" { continue }
		seen[uid] = true
		_, _ = tx.Exec(bgCtx, `INSERT INTO channel_members (channel_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, channelID, uid)
	}
	if err := tx.Commit(bgCtx); err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": "błąd commit"}); return }
	c.JSON(http.StatusCreated, gin.H{"channel_id": channelID, "name": strings.TrimSpace(req.Name)})
}

type AddMemberRequest struct {
	UserID string `json:"user_id" binding:"required"`
}

func (h *Handlers) AddChannelMember(c *gin.Context) {
	channelID := c.Param("channel_id")
	requesterID := c.GetString(auth.UserIDKey)
	bgCtx := context.Background()
	var req AddMemberRequest
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()}); return }
	if !h.isMember(bgCtx, channelID, requesterID) { c.JSON(http.StatusForbidden, gin.H{"error": "brak dostępu"}); return }
	_, err := h.db.Pool.Exec(bgCtx,
		`INSERT INTO channel_members (channel_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, channelID, req.UserID)
	if err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": "błąd dodawania"}); return }

	// Powiadom dodanego użytkownika o nowym kanale przez WS
	var ch models.Channel
	if err := h.db.Pool.QueryRow(bgCtx, `SELECT id, name, is_direct, created_by, created_at FROM channels WHERE id=$1`, channelID).Scan(
		&ch.ID, &ch.Name, &ch.IsDirect, &ch.CreatedBy, &ch.CreatedAt); err == nil {
		h.hub.SendToUser(req.UserID, &models.WSMessage{Type: models.WSTypeChannelAdded, Payload: ch})
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// LeaveChannel – opuszcza kanał (nie dotyczy DM)
func (h *Handlers) LeaveChannel(c *gin.Context) {
	channelID := c.Param("channel_id")
	userID := c.GetString(auth.UserIDKey)
	bgCtx := context.Background()

	// Sprawdź czy to nie jest DM
	var isDirect bool
	_ = h.db.Pool.QueryRow(bgCtx, `SELECT is_direct FROM channels WHERE id=$1`, channelID).Scan(&isDirect)
	if isDirect {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nie można opuścić wiadomości bezpośredniej"})
		return
	}

	_, err := h.db.Pool.Exec(bgCtx, `DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2`, channelID, userID)
	if err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": "błąd opuszczania kanału"}); return }
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handlers) CreateDirectChannel(c *gin.Context) {
	userID := c.GetString(auth.UserIDKey)
	targetID := c.Param("target_id")
	bgCtx := context.Background()

	var existingID string
	err := h.db.Pool.QueryRow(bgCtx, `
		SELECT ch.id FROM channels ch
		JOIN channel_members cm1 ON cm1.channel_id=ch.id AND cm1.user_id=$1
		JOIN channel_members cm2 ON cm2.channel_id=ch.id AND cm2.user_id=$2
		WHERE ch.is_direct=TRUE LIMIT 1`, userID, targetID,
	).Scan(&existingID)
	if err == nil { c.JSON(http.StatusOK, gin.H{"channel_id": existingID, "existing": true}); return }

	channelName := fmt.Sprintf("dm:%s:%s", userID, targetID)
	tx, _ := h.db.Pool.Begin(bgCtx)
	defer tx.Rollback(bgCtx)
	var channelID string
	_ = tx.QueryRow(bgCtx, `INSERT INTO channels (name,is_direct,created_by) VALUES ($1,TRUE,$2) RETURNING id`, channelName, userID).Scan(&channelID)
	for _, uid := range []string{userID, targetID} {
		_, _ = tx.Exec(bgCtx, `INSERT INTO channel_members (channel_id,user_id) VALUES ($1,$2)`, channelID, uid)
	}
	_ = tx.Commit(bgCtx)
	c.JSON(http.StatusCreated, gin.H{"channel_id": channelID, "existing": false})
}

// ─── MESSAGES ─────────────────────────────────────────────────────────────────

func (h *Handlers) GetMessages(c *gin.Context) {
	channelID := c.Param("channel_id")
	userID := c.GetString(auth.UserIDKey)
	bgCtx := context.Background()
	if !h.isMember(bgCtx, channelID, userID) { c.JSON(http.StatusForbidden, gin.H{"error": "brak dostępu"}); return }

	rows, err := h.db.Pool.Query(bgCtx, `
		SELECT m.id, m.channel_id, m.sender_id, m.type, m.content, m.metadata, m.created_at,
		       u.display_name, u.username, u.avatar_color
		FROM messages m JOIN users u ON u.id=m.sender_id
		WHERE m.channel_id=$1 ORDER BY m.created_at DESC LIMIT 200`, channelID)
	if err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": "błąd bazy"}); return }
	defer rows.Close()

	var messages []models.Message
	for rows.Next() {
		var msg models.Message
		var metaJSON []byte
		var sender models.User
		if err := rows.Scan(&msg.ID, &msg.ChannelID, &msg.SenderID, &msg.Type, &msg.Content,
			&metaJSON, &msg.CreatedAt, &sender.DisplayName, &sender.Username, &sender.AvatarColor); err != nil {
			continue
		}
		sender.ID = msg.SenderID
		msg.Sender = &sender
		if len(metaJSON) > 0 { _ = json.Unmarshal(metaJSON, &msg.Metadata) }
		messages = append(messages, msg)
	}
	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 { messages[i], messages[j] = messages[j], messages[i] }
	if messages == nil { messages = []models.Message{} }
	c.JSON(http.StatusOK, messages)
}

// SearchMessages – wyszukuje wiadomości po treści we wszystkich kanałach użytkownika
// GET /api/messages/search?q=tekst&limit=50
func (h *Handlers) SearchMessages(c *gin.Context) {
	userID := c.GetString(auth.UserIDKey)
	query := strings.TrimSpace(c.Query("q"))
	if query == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "parametr 'q' jest wymagany"})
		return
	}

	limitStr := c.DefaultQuery("limit", "50")
	limit, err := strconv.Atoi(limitStr)
	if err != nil || limit < 1 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	bgCtx := context.Background()

	// Wyszukaj w kanałach, do których użytkownik należy
	// Używa ILIKE jako fallback (prostsze, nie wymaga konfiguracji locale)
	// oraz to_tsvector/plainto_tsquery dla dłuższych fraz
	rows, err := h.db.Pool.Query(bgCtx, `
		SELECT m.id, m.channel_id, m.sender_id, m.type, m.content, m.metadata, m.created_at,
		       u.display_name, u.username, u.avatar_color,
		       ch.name AS channel_name, ch.is_direct
		FROM messages m
		JOIN users u ON u.id = m.sender_id
		JOIN channels ch ON ch.id = m.channel_id
		JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = $1
		WHERE (
			m.content ILIKE '%' || $2 || '%'
			OR to_tsvector('simple', m.content) @@ plainto_tsquery('simple', $2)
		)
		AND m.type IN ('text', 'code_snippet', 'system')
		ORDER BY m.created_at DESC
		LIMIT $3`, userID, query, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "błąd wyszukiwania"})
		return
	}
	defer rows.Close()

	type SearchResult struct {
		models.Message
		ChannelName string `json:"channel_name"`
		IsDirect    bool   `json:"is_direct"`
	}

	var results []SearchResult
	for rows.Next() {
		var r SearchResult
		var metaJSON []byte
		var sender models.User
		if err := rows.Scan(&r.ID, &r.ChannelID, &r.SenderID, &r.Type, &r.Content,
			&metaJSON, &r.CreatedAt, &sender.DisplayName, &sender.Username, &sender.AvatarColor,
			&r.ChannelName, &r.IsDirect); err != nil {
			continue
		}
		sender.ID = r.SenderID
		r.Sender = &sender
		if len(metaJSON) > 0 {
			_ = json.Unmarshal(metaJSON, &r.Metadata)
		}
		results = append(results, r)
	}
	if results == nil {
		results = []SearchResult{}
	}
	c.JSON(http.StatusOK, results)
}

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────

func (h *Handlers) WebSocket(c *gin.Context) {
	userID := c.GetString(auth.UserIDKey)
	username := c.GetString(auth.UsernameKey)
	displayName := c.GetString(auth.DisplayNameKey)
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil { return }
	client := hub.NewClient(h.hub, conn, userID, username, displayName, h.cache, h.routeWSMessage)
	h.hub.Register(client)
	go client.WritePump()
	go client.ReadPump()
}

func (h *Handlers) routeWSMessage(client *hub.Client, msg *models.WSMessage) {
	switch msg.Type {
	case models.WSTypeChatMessage:
		h.handleChatMessage(client, msg)
	case models.WSTypeRTCOffer, models.WSTypeRTCAnswer, models.WSTypeICECandidate, models.WSTypeRTCDecline:
		if msg.TargetID != "" { msg.SenderID = client.UserID; h.hub.SendToUser(msg.TargetID, msg) }
	case models.WSTypeTyping:
		if msg.ChannelID != "" { h.hub.SendToChannel(h.getChannelMembers(msg.ChannelID), msg, client.UserID) }
	}
}

func (h *Handlers) handleChatMessage(client *hub.Client, msg *models.WSMessage) {
	payloadBytes, _ := json.Marshal(msg.Payload)
	var payload struct {
		Content   string              `json:"content"`
		Type      models.MessageType  `json:"type"`
		Metadata  *models.MessageMeta `json:"metadata"`
		ChannelID string              `json:"channel_id"`
	}
	if err := json.Unmarshal(payloadBytes, &payload); err != nil { return }
	channelID := payload.ChannelID
	if channelID == "" { channelID = msg.ChannelID }
	if !h.isMember(context.Background(), channelID, client.UserID) { return }
	msgType := payload.Type
	if msgType == "" { msgType = models.MessageTypeText }
	var metaJSON []byte
	if payload.Metadata != nil { metaJSON, _ = json.Marshal(payload.Metadata) }
	var msgID string
	_ = h.db.Pool.QueryRow(context.Background(), `
		INSERT INTO messages (channel_id,sender_id,type,content,metadata) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		channelID, client.UserID, msgType, payload.Content, metaJSON).Scan(&msgID)

	outMsg := &models.Message{
		ID: msgID, ChannelID: channelID, SenderID: client.UserID,
		Sender: &models.User{ID: client.UserID, Username: client.Username, DisplayName: client.DisplayName},
		Type: msgType, Content: payload.Content, Metadata: payload.Metadata, CreatedAt: time.Now(),
	}
	wsMsg := &models.WSMessage{Type: models.WSTypeChatMessage, ChannelID: channelID, SenderID: client.UserID, Payload: outMsg}
	for _, memberID := range h.getChannelMembers(channelID) {
		h.hub.SendToUser(memberID, wsMsg)
	}
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

func (h *Handlers) isMember(ctx context.Context, channelID, userID string) bool {
	var exists bool
	_ = h.db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2)`, channelID, userID).Scan(&exists)
	return exists
}

func (h *Handlers) getChannelMembers(channelID string) []string {
	rows, err := h.db.Pool.Query(context.Background(), `SELECT user_id FROM channel_members WHERE channel_id=$1`, channelID)
	if err != nil { return nil }
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil { ids = append(ids, id) }
	}
	return ids
}

func (h *Handlers) ensureGeneralChannel(ctx context.Context, userID string) {
	var channelID string
	err := h.db.Pool.QueryRow(ctx, `SELECT id FROM channels WHERE name='ogólny' LIMIT 1`).Scan(&channelID)
	if err != nil {
		newID := uuid.New().String()
		if err2 := h.db.Pool.QueryRow(ctx, `INSERT INTO channels (id,name,created_by) VALUES ($1,'ogólny',$2) RETURNING id`, newID, userID).Scan(&channelID); err2 != nil { return }
	}
	_, _ = h.db.Pool.Exec(ctx, `INSERT INTO channel_members (channel_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, channelID, userID)
}

// upsertLDAPUser – tworzy lub aktualizuje użytkownika z AD w lokalnej bazie
func (h *Handlers) upsertLDAPUser(ctx context.Context, info *LDAPUserInfo) (userID, displayName, avatarColor string, err error) {
	colors := []string{"#6366f1", "#ec4899", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6"}
	color := colors[len(info.Username)%len(colors)]

	err = h.db.Pool.QueryRow(ctx, `
		INSERT INTO users (username, display_name, password_hash, avatar_color)
		VALUES ($1, $2, 'LDAP_AUTH_NO_LOCAL_PASSWORD', $3)
		ON CONFLICT (username) DO UPDATE
		  SET display_name=EXCLUDED.display_name, last_seen=NOW()
		RETURNING id, display_name, avatar_color`,
		info.Username, info.DisplayName, color,
	).Scan(&userID, &displayName, &avatarColor)
	if err != nil { return }
	h.ensureGeneralChannel(ctx, userID)
	return
}
