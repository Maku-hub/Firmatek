package handlers

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"firmatek/server/internal/auth"
	"firmatek/server/internal/models"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

func (h *Handlers) GetChannels(c *gin.Context) {
	rows, err := h.db.Pool.Query(c.Request.Context(), `
		SELECT `+channelColumns+`
		FROM channels ch
		JOIN channel_members cm ON cm.channel_id=ch.id
		WHERE cm.user_id=$1
		ORDER BY ch.is_direct, ch.name`, c.GetString(auth.UserIDKey))
	if err != nil {
		serverError(c, "database error", err)
		return
	}
	channels, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (models.Channel, error) {
		return scanChannel(row)
	})
	if err != nil {
		serverError(c, "database error", err)
		return
	}
	c.JSON(http.StatusOK, channels)
}

func (h *Handlers) GetChannelMembers(c *gin.Context) {
	ctx := c.Request.Context()
	channelID := c.Param("channel_id")
	if !h.isMember(ctx, channelID, c.GetString(auth.UserIDKey)) {
		c.JSON(http.StatusForbidden, gin.H{"error": "access denied"})
		return
	}
	rows, err := h.db.Pool.Query(ctx, `
		SELECT u.id, u.username, u.display_name, u.avatar_color, u.created_at, u.last_seen
		FROM users u JOIN channel_members cm ON cm.user_id=u.id
		WHERE cm.channel_id=$1 ORDER BY u.display_name`, channelID)
	if err != nil {
		serverError(c, "database error", err)
		return
	}
	members, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (models.User, error) {
		var u models.User
		err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarColor, &u.CreatedAt, &u.LastSeen)
		u.Online = h.hub.IsOnline(u.ID)
		return u, err
	})
	if err != nil {
		serverError(c, "database error", err)
		return
	}
	c.JSON(http.StatusOK, members)
}

type CreateChannelRequest struct {
	Name    string   `json:"name" binding:"required"`
	Members []string `json:"members"`
}

func (h *Handlers) CreateChannel(c *gin.Context) {
	userID := c.GetString(auth.UserIDKey)
	var req CreateChannelRequest
	if !bindJSON(c, &req) {
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || utf8.RuneCountInString(name) > 100 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "channel name must be 1-100 characters"})
		return
	}
	if strings.HasPrefix(name, "dm:") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "channel name cannot start with \"dm:\""})
		return
	}

	memberIDs := []string{userID}
	seen := map[string]bool{userID: true}
	for _, id := range req.Members {
		if isUUID(id) && !seen[id] {
			seen[id] = true
			memberIDs = append(memberIDs, id)
		}
	}

	ctx := c.Request.Context()
	tx, err := h.db.Pool.Begin(ctx)
	if err != nil {
		serverError(c, "could not create channel", err)
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit

	ch, err := scanChannel(tx.QueryRow(ctx, `
		INSERT INTO channels AS ch (name, created_by) VALUES ($1, $2)
		RETURNING `+channelColumns, name, userID))
	if err != nil {
		serverError(c, "could not create channel", err)
		return
	}
	// Unknown IDs and the system account are skipped instead of failing the
	// whole request.
	rows, err := tx.Query(ctx, `
		INSERT INTO channel_members (channel_id, user_id)
		SELECT $1, u.id FROM users u WHERE u.id = ANY($2::uuid[]) AND u.username <> $3
		ON CONFLICT DO NOTHING
		RETURNING user_id`, ch.ID, memberIDs, systemUsername)
	if err != nil {
		serverError(c, "could not create channel", err)
		return
	}
	added, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		serverError(c, "could not create channel", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		serverError(c, "could not create channel", err)
		return
	}

	for _, id := range added {
		if id != userID {
			h.hub.SendToUser(id, &models.WSMessage{Type: models.WSTypeChannelAdded, Payload: ch})
		}
	}
	c.JSON(http.StatusCreated, gin.H{"channel_id": ch.ID, "name": ch.Name, "channel": ch})
}

type AddMemberRequest struct {
	UserID string `json:"user_id" binding:"required"`
}

func (h *Handlers) AddChannelMember(c *gin.Context) {
	ctx := c.Request.Context()
	channelID := c.Param("channel_id")
	var req AddMemberRequest
	if !bindJSON(c, &req) {
		return
	}
	if !h.isMember(ctx, channelID, c.GetString(auth.UserIDKey)) {
		c.JSON(http.StatusForbidden, gin.H{"error": "access denied"})
		return
	}
	ch, err := h.channelByID(ctx, channelID)
	if err != nil {
		serverError(c, "database error", err)
		return
	}
	if ch.IsDirect {
		c.JSON(http.StatusBadRequest, gin.H{"error": "people cannot be added to a direct conversation"})
		return
	}
	if !isUUID(req.UserID) {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}

	tag, err := h.db.Pool.Exec(ctx, `
		INSERT INTO channel_members (channel_id, user_id)
		SELECT $1, id FROM users WHERE id=$2 AND username <> $3
		ON CONFLICT DO NOTHING`, channelID, req.UserID, systemUsername)
	if err != nil {
		serverError(c, "could not add member", err)
		return
	}
	if tag.RowsAffected() == 1 {
		h.hub.SendToUser(req.UserID, &models.WSMessage{Type: models.WSTypeChannelAdded, Payload: ch})
	} else if !h.isMember(ctx, channelID, req.UserID) {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// LeaveChannel removes the caller from a group channel. Direct conversations
// cannot be left.
func (h *Handlers) LeaveChannel(c *gin.Context) {
	ctx := c.Request.Context()
	channelID := c.Param("channel_id")
	if !isUUID(channelID) {
		c.JSON(http.StatusNotFound, gin.H{"error": "channel not found"})
		return
	}
	ch, err := h.channelByID(ctx, channelID)
	if errors.Is(err, pgx.ErrNoRows) {
		c.JSON(http.StatusNotFound, gin.H{"error": "channel not found"})
		return
	}
	if err != nil {
		serverError(c, "database error", err)
		return
	}
	if ch.IsDirect {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot leave a direct conversation"})
		return
	}
	if _, err := h.db.Pool.Exec(ctx,
		`DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2`,
		channelID, c.GetString(auth.UserIDKey)); err != nil {
		serverError(c, "could not leave channel", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// CreateDirectChannel returns the caller's conversation with target_id,
// creating it if needed.
func (h *Handlers) CreateDirectChannel(c *gin.Context) {
	ctx := c.Request.Context()
	userID := c.GetString(auth.UserIDKey)
	targetID := c.Param("target_id")
	if targetID == userID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot start a conversation with yourself"})
		return
	}
	if !isUUID(targetID) {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}

	tx, err := h.db.Pool.Begin(ctx)
	if err != nil {
		serverError(c, "could not open conversation", err)
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit

	// Serialise creation per pair of users so a double click, or both people
	// opening the conversation at once, cannot create two channels.
	pair := userID + ":" + targetID
	if targetID < userID {
		pair = targetID + ":" + userID
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "dm:"+pair); err != nil {
		serverError(c, "could not open conversation", err)
		return
	}

	var existingID string
	err = tx.QueryRow(ctx, `
		SELECT ch.id FROM channels ch
		JOIN channel_members a ON a.channel_id=ch.id AND a.user_id=$1
		JOIN channel_members b ON b.channel_id=ch.id AND b.user_id=$2
		WHERE ch.is_direct LIMIT 1`, userID, targetID).Scan(&existingID)
	if err == nil {
		c.JSON(http.StatusOK, gin.H{"channel_id": existingID, "existing": true})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		serverError(c, "could not open conversation", err)
		return
	}

	var targetExists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND username <> $2)`,
		targetID, systemUsername).Scan(&targetExists); err != nil {
		serverError(c, "could not open conversation", err)
		return
	}
	if !targetExists {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}

	ch, err := scanChannel(tx.QueryRow(ctx, `
		INSERT INTO channels AS ch (name, is_direct, created_by) VALUES ($1, TRUE, $2)
		RETURNING `+channelColumns, fmt.Sprintf("dm:%s:%s", userID, targetID), userID))
	if err != nil {
		serverError(c, "could not open conversation", err)
		return
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)`,
		ch.ID, userID, targetID); err != nil {
		serverError(c, "could not open conversation", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		serverError(c, "could not open conversation", err)
		return
	}

	h.hub.SendToUser(targetID, &models.WSMessage{Type: models.WSTypeChannelAdded, Payload: ch})
	c.JSON(http.StatusCreated, gin.H{"channel_id": ch.ID, "existing": false, "channel": ch})
}
