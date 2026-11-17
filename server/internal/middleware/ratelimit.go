// Package middleware provides small, dependency-free HTTP/WS helpers such as a
// per-key token-bucket rate limiter.
package middleware

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// RateLimiter is a simple in-memory token-bucket limiter keyed by an arbitrary
// string (e.g. client IP or user ID). Safe for concurrent use.
type RateLimiter struct {
	mu        sync.Mutex
	buckets   map[string]*bucket
	rate      float64 // tokens added per second
	burst     float64 // max tokens
	lastSweep time.Time
}

type bucket struct {
	tokens float64
	last   time.Time
}

// NewRateLimiter allows `burst` requests immediately and then refills at
// `perWindow` requests per `window`.
func NewRateLimiter(perWindow int, window time.Duration, burst int) *RateLimiter {
	return &RateLimiter{
		buckets:   make(map[string]*bucket),
		rate:      float64(perWindow) / window.Seconds(),
		burst:     float64(burst),
		lastSweep: time.Now(),
	}
}

// Allow reports whether a request for the given key may proceed, consuming one
// token if so.
func (l *RateLimiter) Allow(key string) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	l.sweep(now)

	b, ok := l.buckets[key]
	if !ok {
		l.buckets[key] = &bucket{tokens: l.burst - 1, last: now}
		return true
	}
	// Refill based on elapsed time.
	b.tokens += now.Sub(b.last).Seconds() * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// sweep drops buckets that have fully refilled to keep memory bounded. Caller
// must hold the lock.
func (l *RateLimiter) sweep(now time.Time) {
	if now.Sub(l.lastSweep) < 5*time.Minute {
		return
	}
	l.lastSweep = now
	for k, b := range l.buckets {
		if b.tokens+now.Sub(b.last).Seconds()*l.rate >= l.burst {
			delete(l.buckets, k)
		}
	}
}

// RateLimit is a Gin middleware that rejects requests exceeding the limiter,
// keyed by client IP.
func RateLimit(l *RateLimiter) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !l.Allow(c.ClientIP()) {
			c.Header("Retry-After", "60")
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "too many requests, slow down"})
			c.Abort()
			return
		}
		c.Next()
	}
}
