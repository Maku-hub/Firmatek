package auth

import (
	"testing"

	"firmatek/server/internal/config"
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

func TestValidateRejectsWrongSecret(t *testing.T) {
	Init(&config.JWTConfig{Secret: "secret-a-1234567890"})
	tok, _ := GenerateToken("u", "u", "u")
	Init(&config.JWTConfig{Secret: "secret-b-0987654321"})
	if _, err := ValidateToken(tok); err == nil {
		t.Fatal("expected error when validating with a different secret")
	}
}
