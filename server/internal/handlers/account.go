package handlers

import (
	"context"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"firmatek/server/internal/auth"
	"firmatek/server/internal/models"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/bcrypt"
)

var usernamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{2,49}$`)

// bcrypt ignores everything past 72 bytes, so longer passwords are refused
// rather than silently truncated.
const maxPasswordBytes = 72

type RegisterRequest struct {
	Username    string `json:"username" binding:"required"`
	DisplayName string `json:"display_name" binding:"required"`
	Password    string `json:"password" binding:"required,min=6"`
}

func (h *Handlers) Register(c *gin.Context) {
	if !h.cfg.RegistrationOpen() {
		c.JSON(http.StatusForbidden, gin.H{"error": "registration is disabled"})
		return
	}

	var req RegisterRequest
	if !bindJSON(c, &req) {
		return
	}
	username := strings.ToLower(strings.TrimSpace(req.Username))
	displayName := strings.TrimSpace(req.DisplayName)

	switch {
	case !usernamePattern.MatchString(username):
		c.JSON(http.StatusBadRequest, gin.H{"error": "username must be 3-50 characters: letters, digits, '.', '_' or '-'"})
		return
	case username == systemUsername:
		c.JSON(http.StatusConflict, gin.H{"error": "username is already taken"})
		return
	case utf8.RuneCountInString(displayName) < 2 || utf8.RuneCountInString(displayName) > 100:
		c.JSON(http.StatusBadRequest, gin.H{"error": "display name must be 2-100 characters"})
		return
	case len(req.Password) > maxPasswordBytes:
		c.JSON(http.StatusBadRequest, gin.H{"error": "password is too long"})
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		serverError(c, "could not create account", err)
		return
	}

	ctx := c.Request.Context()
	user := models.User{Username: username, DisplayName: displayName, AvatarColor: avatarColor(username)}
	err = h.db.Pool.QueryRow(ctx, `
		INSERT INTO users (username, display_name, password_hash, avatar_color)
		VALUES ($1, $2, $3, $4) RETURNING id, created_at, last_seen`,
		user.Username, user.DisplayName, string(hash), user.AvatarColor,
	).Scan(&user.ID, &user.CreatedAt, &user.LastSeen)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			c.JSON(http.StatusConflict, gin.H{"error": "username is already taken"})
			return
		}
		serverError(c, "could not create account", err)
		return
	}
	if err := h.ensureGeneralChannel(ctx, user.ID); err != nil {
		log.Printf("register: join %q for %s: %v", generalChannel, user.ID, err)
	}

	token, err := auth.GenerateToken(user.ID, user.Username, user.DisplayName)
	if err != nil {
		serverError(c, "could not issue token", err)
		return
	}

	h.hub.SendToAll(&models.WSMessage{Type: models.WSTypeUserNew, Payload: user})
	c.JSON(http.StatusCreated, gin.H{"token": token, "user_id": user.ID, "user": user})
}

type LoginRequest struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
}

func (h *Handlers) Login(c *gin.Context) {
	var req LoginRequest
	if !bindJSON(c, &req) {
		return
	}
	username := strings.ToLower(strings.TrimSpace(req.Username))

	// Per-account limit, independent of the source address, so a whole office
	// behind one NAT does not share a budget.
	if !h.loginLimiter.Allow(username) {
		c.Header("Retry-After", "60")
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "too many login attempts, try again in a minute"})
		return
	}
	if username == systemUsername {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid username or password"})
		return
	}

	ctx := c.Request.Context()
	var (
		user models.User
		err  error
	)
	if h.cfg.LDAP.Enabled {
		user, err = h.loginLDAP(ctx, username, req.Password)
	} else {
		user, err = h.loginLocal(ctx, username, req.Password)
	}
	switch {
	case errors.Is(err, errInvalidCredentials):
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid username or password"})
		return
	case err != nil:
		log.Printf("login %q: %v", username, err)
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sign-in is temporarily unavailable"})
		return
	}

	token, err := auth.GenerateToken(user.ID, user.Username, user.DisplayName)
	if err != nil {
		serverError(c, "could not issue token", err)
		return
	}
	user.Online = h.hub.IsOnline(user.ID)
	c.JSON(http.StatusOK, gin.H{"token": token, "user": user})
}

func (h *Handlers) loginLocal(ctx context.Context, username, password string) (models.User, error) {
	var user models.User
	var hash string
	err := h.db.Pool.QueryRow(ctx, `
		SELECT id, username, display_name, avatar_color, created_at, password_hash
		FROM users WHERE username=$1`, username,
	).Scan(&user.ID, &user.Username, &user.DisplayName, &user.AvatarColor, &user.CreatedAt, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		_ = bcrypt.CompareHashAndPassword(h.dummyHash, []byte(password))
		return user, errInvalidCredentials
	}
	if err != nil {
		return user, err
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return user, errInvalidCredentials
	}
	err = h.db.Pool.QueryRow(ctx,
		`UPDATE users SET last_seen=NOW() WHERE id=$1 RETURNING last_seen`, user.ID).Scan(&user.LastSeen)
	return user, err
}

func (h *Handlers) loginLDAP(ctx context.Context, username, password string) (models.User, error) {
	info, err := AuthenticateLDAP(&h.cfg.LDAP, username, password)
	if err != nil {
		return models.User{}, err
	}
	if info.Username == systemUsername {
		return models.User{}, errInvalidCredentials
	}

	user := models.User{Username: info.Username}
	err = h.db.Pool.QueryRow(ctx, `
		INSERT INTO users (username, display_name, password_hash, avatar_color)
		VALUES ($1, $2, 'LDAP_AUTH_NO_LOCAL_PASSWORD', $3)
		ON CONFLICT (username) DO UPDATE
		  SET display_name=EXCLUDED.display_name, last_seen=NOW()
		RETURNING id, display_name, avatar_color, created_at, last_seen`,
		info.Username, info.DisplayName, avatarColor(info.Username),
	).Scan(&user.ID, &user.DisplayName, &user.AvatarColor, &user.CreatedAt, &user.LastSeen)
	if err != nil {
		return user, err
	}
	if err := h.ensureGeneralChannel(ctx, user.ID); err != nil {
		log.Printf("login: join %q for %s: %v", generalChannel, user.ID, err)
	}
	return user, nil
}

// RefreshToken issues a fresh token for a still-valid one, so a client that
// stays open does not get logged out every 24 hours. The user is re-read from
// the database, which also picks up display name changes.
func (h *Handlers) RefreshToken(c *gin.Context) {
	user, ok := h.currentUser(c)
	if !ok {
		return
	}
	token, err := auth.GenerateToken(user.ID, user.Username, user.DisplayName)
	if err != nil {
		serverError(c, "could not issue token", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"token": token, "user": user})
}

// GetMe returns the signed-in user (used for automatic login on start-up).
func (h *Handlers) GetMe(c *gin.Context) {
	if user, ok := h.currentUser(c); ok {
		c.JSON(http.StatusOK, user)
	}
}

func (h *Handlers) currentUser(c *gin.Context) (models.User, bool) {
	var user models.User
	err := h.db.Pool.QueryRow(c.Request.Context(), `
		SELECT id, username, display_name, avatar_color, created_at, last_seen
		FROM users WHERE id=$1`, c.GetString(auth.UserIDKey),
	).Scan(&user.ID, &user.Username, &user.DisplayName, &user.AvatarColor, &user.CreatedAt, &user.LastSeen)
	if errors.Is(err, pgx.ErrNoRows) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "user no longer exists"})
		return user, false
	}
	if err != nil {
		serverError(c, "database error", err)
		return user, false
	}
	user.Online = true
	return user, true
}

// GetAuthConfig tells the login screen which sign-in options to show.
func (h *Handlers) GetAuthConfig(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"ldap_enabled":         h.cfg.LDAP.Enabled,
		"registration_enabled": h.cfg.RegistrationOpen(),
		"app_name":             h.cfg.App.Name,
	})
}

func (h *Handlers) GetUsers(c *gin.Context) {
	rows, err := h.db.Pool.Query(c.Request.Context(), `
		SELECT id, username, display_name, avatar_color, created_at, last_seen
		FROM users WHERE username <> $1 ORDER BY display_name`, systemUsername)
	if err != nil {
		serverError(c, "database error", err)
		return
	}
	users, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (models.User, error) {
		var u models.User
		err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarColor, &u.CreatedAt, &u.LastSeen)
		u.Online = h.hub.IsOnline(u.ID)
		return u, err
	})
	if err != nil {
		serverError(c, "database error", err)
		return
	}
	c.JSON(http.StatusOK, users)
}
