package auth

import (
	"testing"
	"time"

	"firmatek/server/internal/config"

	"github.com/golang-jwt/jwt/v5"
)

func TestTokenRoundTrip(t *testing.T) {
	Init(&config.JWTConfig{Secret: "unit-test-secret-value-1234567890"})
	tok, err := GenerateToken("uid-1", "alice", "Alice Anderson")
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	claims, err := ValidateToken(tok)
	if err != nil {
		t.Fatalf("ValidateToken: %v", err)
	}
	if claims.UserID != "uid-1" || claims.Username != "alice" || claims.DisplayName != "Alice Anderson" {
		t.Fatalf("unexpected claims: %+v", claims)
	}
}

func TestValidateRejectsGarbage(t *testing.T) {
	Init(&config.JWTConfig{Secret: "s"})
	if _, err := ValidateToken("not.a.valid.token"); err == nil {
		t.Fatal("expected error for malformed token")
	}
	if _, err := ValidateToken(""); err == nil {
		t.Fatal("expected error for empty token")
	}
}

func TestValidateRejectsOtherAlgorithms(t *testing.T) {
	secret := "unit-test-secret-value-1234567890"
	Init(&config.JWTConfig{Secret: secret})
	claims := Claims{
		UserID: "u",
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
			Issuer:    issuer,
		},
	}
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS512, claims).SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateToken(tok); err == nil {
		t.Fatal("expected HS512 token to be rejected")
	}
}

func TestValidateRejectsMissingExpiry(t *testing.T) {
	secret := "unit-test-secret-value-1234567890"
	Init(&config.JWTConfig{Secret: secret})
	claims := Claims{UserID: "u", RegisteredClaims: jwt.RegisteredClaims{Issuer: issuer}}
	tok, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
	if _, err := ValidateToken(tok); err == nil {
		t.Fatal("expected token without exp to be rejected")
	}
}

func TestValidateRejectsWrongSecret(t *testing.T) {
	Init(&config.JWTConfig{Secret: "secret-a-1234567890"})
	tok, _ := GenerateToken("u", "u", "u")
	Init(&config.JWTConfig{Secret: "secret-b-0987654321"})
	if _, err := ValidateToken(tok); err == nil {
		t.Fatal("expected error when validating with a different secret")
	}
}
