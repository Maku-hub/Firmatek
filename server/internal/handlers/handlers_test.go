package handlers

import (
	"testing"
)

func TestEscapeLike(t *testing.T) {
	cases := map[string]string{
		"plain":    "plain",
		"100%":     `100\%`,
		"snake_id": `snake\_id`,
		`a\b`:      `a\\b`,
	}
	for in, want := range cases {
		if got := escapeLike(in); got != want {
			t.Errorf("escapeLike(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestUsernamePattern(t *testing.T) {
	valid := []string{"alice", "jan.kowalski", "dev_ops-1", "abc"}
	invalid := []string{"ab", "-dash", "with space", "ąę", "UPPER", ""}
	for _, u := range valid {
		if !usernamePattern.MatchString(u) {
			t.Errorf("%q should be accepted", u)
		}
	}
	for _, u := range invalid {
		if usernamePattern.MatchString(u) {
			t.Errorf("%q should be rejected", u)
		}
	}
}

func TestTruncateCountsCharacters(t *testing.T) {
	if got := truncate("  zażółć  ", 3); got != "zaż" {
		t.Fatalf("truncate = %q", got)
	}
	if got := truncate("go", 10); got != "go" {
		t.Fatalf("truncate = %q", got)
	}
}

func TestLDAPHost(t *testing.T) {
	cases := map[string]string{
		"ldap://dc.firma.local:389": "dc.firma.local",
		"ldaps://dc.firma.local":    "dc.firma.local",
		"ldap://[::1]:389":          "::1",
	}
	for in, want := range cases {
		if got := ldapHost(in); got != want {
			t.Errorf("ldapHost(%q) = %q, want %q", in, got, want)
		}
	}
}
