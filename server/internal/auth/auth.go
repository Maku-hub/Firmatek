package auth

import (
	"errors"
	"time"

	"firmatek/server/internal/config"

	"github.com/golang-jwt/jwt/v5"
)

// TokenTTL is how long an issued token stays valid. Clients renew it through
// /api/auth/refresh while they are running.
const TokenTTL = 24 * time.Hour

const issuer = "firmatek"

type Claims struct {
	UserID      string `json:"user_id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	jwt.RegisteredClaims
}

var jwtSecret []byte

func Init(cfg *config.JWTConfig) {
	jwtSecret = []byte(cfg.Secret)
}

func GenerateToken(userID, username, displayName string) (string, error) {
	now := time.Now()
	claims := Claims{
		UserID:      userID,
		Username:    username,
		DisplayName: displayName,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(TokenTTL)),
			IssuedAt:  jwt.NewNumericDate(now),
			Issuer:    issuer,
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(jwtSecret)
}

func ValidateToken(tokenStr string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		return jwtSecret, nil
	},
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(issuer),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return nil, err
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid || claims.UserID == "" {
		return nil, errors.New("invalid token")
	}
	return claims, nil
}
