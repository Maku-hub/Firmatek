package handlers

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"reflect"
	"strings"
	"time"

	"firmatek/server/internal/config"
	"firmatek/server/internal/database"
	"firmatek/server/internal/hub"
	"firmatek/server/internal/middleware"
	"firmatek/server/internal/models"

	"github.com/gin-gonic/gin"
	"github.com/gin-gonic/gin/binding"
	"github.com/go-playground/validator/v10"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

const (
	generalChannel = "general"
	// systemUsername is the author of CI/CD notifications. Nobody can register
	// or log in under this name.
	systemUsername = "system"
	dbTimeout      = 5 * time.Second
)

var avatarColors = []string{"#6366f1", "#ec4899", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6"}

type Handlers struct {
	db           *database.DB
	hub          *hub.Hub
	cfg          *config.Config
	upgrader     websocket.Upgrader
	msgLimiter   *middleware.RateLimiter // chat messages per user
	loginLimiter *middleware.RateLimiter // login attempts per username
	// dummyHash is compared against when a username does not exist, so a
	// failed login takes the same time either way.
	dummyHash []byte
}

func New(db *database.DB, h *hub.Hub, cfg *config.Config) *Handlers {
	dummy, err := bcrypt.GenerateFromPassword([]byte("firmatek-timing-guard"), bcrypt.DefaultCost)
	if err != nil {
		log.Fatalf("bcrypt: %v", err)
	}
	handlers := &Handlers{
		db: db, hub: h, cfg: cfg,
		msgLimiter:   middleware.NewRateLimiter(120, time.Minute, 30),
		loginLimiter: middleware.NewRateLimiter(10, time.Minute, 10),
		dummyHash:    dummy,
	}
	handlers.upgrader = websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin:     handlers.checkWSOrigin,
	}
	return handlers
}

func init() {
	// Report JSON field names in validation errors instead of Go field names.
	if v, ok := binding.Validator.Engine().(*validator.Validate); ok {
		v.RegisterTagNameFunc(func(f reflect.StructField) string {
			name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
			if name == "" || name == "-" {
				return f.Name
			}
			return name
		})
	}
}

// checkWSOrigin gates WebSocket upgrades. Without ALLOWED_ORIGINS every origin
// is accepted. The desktop client (no Origin, or a Tauri scheme) is always
// allowed.
func (h *Handlers) checkWSOrigin(r *http.Request) bool {
	if len(h.cfg.AllowedOrigins) == 0 {
		return true
	}
	origin := r.Header.Get("Origin")
	if origin == "" ||
		strings.HasPrefix(origin, "tauri://") ||
		strings.HasPrefix(origin, "http://tauri.localhost") ||
		strings.HasPrefix(origin, "https://tauri.localhost") {
		return true
	}
	for _, allowed := range h.cfg.AllowedOrigins {
		if origin == allowed {
			return true
		}
	}
	return false
}

// bindJSON decodes the body into dst. On failure it answers 400 with a message
// a person can read and returns false.
func bindJSON(c *gin.Context, dst any) bool {
	if err := c.ShouldBindJSON(dst); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": validationMessage(err)})
		return false
	}
	return true
}

func validationMessage(err error) string {
	var verrs validator.ValidationErrors
	if !errors.As(err, &verrs) || len(verrs) == 0 {
		return "invalid request body"
	}
	fe := verrs[0]
	field := strings.ReplaceAll(fe.Field(), "_", " ")
	switch fe.Tag() {
	case "required":
		return field + " is required"
	case "min":
		return fmt.Sprintf("%s must be at least %s characters", field, fe.Param())
	case "max":
		return fmt.Sprintf("%s must be at most %s characters", field, fe.Param())
	default:
		return field + " is invalid"
	}
}

func isUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil
}

// serverError logs err and answers with a generic 500.
func serverError(c *gin.Context, what string, err error) {
	log.Printf("%s %s: %s: %v", c.Request.Method, c.FullPath(), what, err)
	c.JSON(http.StatusInternalServerError, gin.H{"error": what})
}

func avatarColor(username string) string {
	var sum int
	for _, r := range username {
		sum += int(r)
	}
	return avatarColors[sum%len(avatarColors)]
}

func (h *Handlers) isMember(ctx context.Context, channelID, userID string) bool {
	if !isUUID(channelID) {
		return false
	}
	var exists bool
	err := h.db.Pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2)`,
		channelID, userID).Scan(&exists)
	return err == nil && exists
}

func (h *Handlers) channelMembers(ctx context.Context, channelID string) ([]string, error) {
	if !isUUID(channelID) {
		return nil, nil
	}
	rows, err := h.db.Pool.Query(ctx, `SELECT user_id FROM channel_members WHERE channel_id=$1`, channelID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

const channelColumns = `ch.id, ch.name, ch.is_direct, COALESCE(ch.created_by::text, ''), ch.created_at`

func scanChannel(row pgx.Row) (models.Channel, error) {
	var ch models.Channel
	err := row.Scan(&ch.ID, &ch.Name, &ch.IsDirect, &ch.CreatedBy, &ch.CreatedAt)
	return ch, err
}

func (h *Handlers) channelByID(ctx context.Context, channelID string) (models.Channel, error) {
	return scanChannel(h.db.Pool.QueryRow(ctx,
		`SELECT `+channelColumns+` FROM channels ch WHERE ch.id=$1`, channelID))
}

// ensureGeneralChannel adds the user to the shared "general" channel, creating
// it on first use. The advisory lock stops two simultaneous first logins from
// creating two channels.
func (h *Handlers) ensureGeneralChannel(ctx context.Context, userID string) error {
	tx, err := h.db.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('firmatek.general_channel'))`); err != nil {
		return err
	}
	var channelID string
	err = tx.QueryRow(ctx,
		`SELECT id FROM channels WHERE name=$1 AND NOT is_direct ORDER BY created_at LIMIT 1`,
		generalChannel).Scan(&channelID)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx,
			`INSERT INTO channels (name, created_by) VALUES ($1, $2) RETURNING id`,
			generalChannel, userID).Scan(&channelID)
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		channelID, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
