package middleware

import (
	"testing"
	"time"
)

func TestBurstThenReject(t *testing.T) {
	l := NewRateLimiter(60, time.Minute, 3)
	for i := 0; i < 3; i++ {
		if !l.Allow("k") {
			t.Fatalf("request %d within burst was rejected", i+1)
		}
	}
	if l.Allow("k") {
		t.Fatal("request over the burst was allowed")
	}
	if !l.Allow("other") {
		t.Fatal("keys must not share a bucket")
	}
}

func TestRefill(t *testing.T) {
	l := NewRateLimiter(60, time.Minute, 1) // one token per second
	l.Allow("k")
	l.buckets["k"].last = time.Now().Add(-1100 * time.Millisecond)
	if !l.Allow("k") {
		t.Fatal("bucket did not refill")
	}
}
