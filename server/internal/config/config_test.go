package config

import (
	"os"
	"testing"
)

func TestLoadRejectsWeakJWTSecret(t *testing.T) {
	cases := []string{
		"short",                                        // too short
		"change_this_in_production",                    // code default (also short)
		"change_me_to_a_long_random_secret_min_32ch!!", // long but placeholder
	}
	for _, secret := range cases {
		os.Setenv("JWT_SECRET", secret)
		if _, err := Load(); err == nil {
			t.Fatalf("expected Load() to reject secret %q", secret)
		}
	}
	os.Unsetenv("JWT_SECRET")
}

func TestLoadAcceptsStrongJWTSecret(t *testing.T) {
	os.Setenv("JWT_SECRET", "0f3a1c9d8b7e6f5a4c3b2d1e0f9a8b7c6d5e4f3a2b1c0d9e")
	defer os.Unsetenv("JWT_SECRET")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cfg.JWT.Secret) < 32 {
		t.Fatal("secret not loaded")
	}
}
