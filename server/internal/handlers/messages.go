package handlers

import (
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"firmatek/server/internal/auth"
	"firmatek/server/internal/models"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

const (
	defaultPageSize = 50
	maxPageSize     = 200
	maxSearchLength = 200
)

func pageSize(c *gin.Context) int {
	n, err := strconv.Atoi(c.Query("limit"))
	if err != nil || n < 1 {
		return defaultPageSize
	}
	return min(n, maxPageSize)
}

// GetMessages returns one page of a channel's history in chronological order.
//
//	?limit=N        page size, 1-200 (default 50)
//	?before=TS      only messages older than this RFC 3339 timestamp
//	?before_id=ID   tie-breaker for messages sharing the same timestamp
//
// To load older history, pass created_at and id of the oldest loaded message.
func (h *Handlers) GetMessages(c *gin.Context) {
	ctx := c.Request.Context()
	channelID := c.Param("channel_id")
	if !h.isMember(ctx, channelID, c.GetString(auth.UserIDKey)) {
		c.JSON(http.StatusForbidden, gin.H{"error": "access denied"})
		return
	}

	const base = `
		SELECT m.id, m.channel_id, m.sender_id, m.type, m.content, m.metadata, m.created_at,
		       u.display_name, u.username, u.avatar_color
		FROM messages m JOIN users u ON u.id=m.sender_id
		WHERE m.channel_id=$1 `
	const order = ` ORDER BY m.created_at DESC, m.id DESC LIMIT $2`

	query := base + order
	args := []any{channelID, pageSize(c)}
	if before := strings.TrimSpace(c.Query("before")); before != "" {
		ts, err := time.Parse(time.RFC3339Nano, before)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "'before' must be an RFC 3339 timestamp"})
			return
		}
		args = append(args, ts)
		if beforeID := c.Query("before_id"); isUUID(beforeID) {
			query = base + `AND (m.created_at, m.id) < ($3, $4)` + order
			args = append(args, beforeID)
		} else {
			query = base + `AND m.created_at < $3` + order
		}
	}

	rows, err := h.db.Pool.Query(ctx, query, args...)
	if err != nil {
		serverError(c, "database error", err)
		return
	}
	messages, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (models.Message, error) {
		var msg models.Message
		var meta []byte
		var sender models.User
		err := row.Scan(&msg.ID, &msg.ChannelID, &msg.SenderID, &msg.Type, &msg.Content,
			&meta, &msg.CreatedAt, &sender.DisplayName, &sender.Username, &sender.AvatarColor)
		sender.ID = msg.SenderID
		msg.Sender = &sender
		if len(meta) > 0 {
			_ = json.Unmarshal(meta, &msg.Metadata)
		}
		return msg, err
	})
	if err != nil {
		serverError(c, "database error", err)
		return
	}
	slices.Reverse(messages)
	c.JSON(http.StatusOK, messages)
}

type SearchResult struct {
	models.Message
	ChannelName string `json:"channel_name"`
	IsDirect    bool   `json:"is_direct"`
}

// SearchMessages looks for text across every channel the caller belongs to.
//
//	GET /api/messages/search?q=text&limit=50
func (h *Handlers) SearchMessages(c *gin.Context) {
	q := strings.TrimSpace(c.Query("q"))
	if q == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "the 'q' parameter is required"})
		return
	}
	if utf8.RuneCountInString(q) > maxSearchLength {
		c.JSON(http.StatusBadRequest, gin.H{"error": "search text is too long"})
		return
	}

	// Substring match (served by the trigram index) plus a word match, so
	// "deploy failed" also finds "failed to deploy".
	rows, err := h.db.Pool.Query(c.Request.Context(), `
		SELECT m.id, m.channel_id, m.sender_id, m.type, m.content, m.metadata, m.created_at,
		       u.display_name, u.username, u.avatar_color,
		       ch.name, ch.is_direct
		FROM messages m
		JOIN users u ON u.id = m.sender_id
		JOIN channels ch ON ch.id = m.channel_id
		JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = $1
		WHERE (
			m.content ILIKE '%' || $2 || '%'
			OR to_tsvector('simple', m.content) @@ plainto_tsquery('simple', $3)
		)
		AND m.type IN ('text', 'code_snippet', 'system')
		ORDER BY m.created_at DESC
		LIMIT $4`, c.GetString(auth.UserIDKey), escapeLike(q), q, pageSize(c))
	if err != nil {
		serverError(c, "search failed", err)
		return
	}
	results, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (SearchResult, error) {
		var r SearchResult
		var meta []byte
		var sender models.User
		err := row.Scan(&r.ID, &r.ChannelID, &r.SenderID, &r.Type, &r.Content,
			&meta, &r.CreatedAt, &sender.DisplayName, &sender.Username, &sender.AvatarColor,
			&r.ChannelName, &r.IsDirect)
		sender.ID = r.SenderID
		r.Sender = &sender
		if len(meta) > 0 {
			_ = json.Unmarshal(meta, &r.Metadata)
		}
		return r, err
	})
	if err != nil {
		serverError(c, "search failed", err)
		return
	}
	c.JSON(http.StatusOK, results)
}

// escapeLike makes LIKE wildcards in user input match literally.
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}
