package handlers

import (
	"strings"
	"testing"
)

func TestBuildNotifyMessageFull(t *testing.T) {
	out := buildNotifyMessage(NotifyRequest{
		Title:   "Deploy finished",
		Message: "v1.2.3 shipped",
		Level:   "success",
		Footer:  "Pipeline #42",
	})
	for _, want := range []string{"✅", "**Deploy finished**", "v1.2.3 shipped", "— Pipeline #42"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output %q missing %q", out, want)
		}
	}
}

func TestBuildNotifyMessageLevels(t *testing.T) {
	cases := map[string]string{"success": "✅", "error": "❌", "warning": "⚠️", "info": "ℹ️", "": "🔔", "bogus": "🔔"}
	for level, icon := range cases {
		out := buildNotifyMessage(NotifyRequest{Title: "T", Message: "M", Level: level})
		if !strings.HasPrefix(out, icon) {
			t.Fatalf("level %q: expected icon %q, got %q", level, icon, out)
		}
	}
}

func TestBuildNotifyMessageMinimal(t *testing.T) {
	// No title => no icon/header line, just the message body.
	out := buildNotifyMessage(NotifyRequest{Message: "just a message"})
	if out != "just a message" {
		t.Fatalf("expected bare message, got %q", out)
	}
}
