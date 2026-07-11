package hub

import (
	"sync"
	"testing"
)

// TestTrySendCloseRace hammers trySend and closeSend from many goroutines while
// a consumer drains the channel. Run with -race: this is the regression guard
// for the "close of closed channel" / send-on-closed panic that used to crash
// the hub. It must complete without panicking and without a data race.
func TestTrySendCloseRace(t *testing.T) {
	for iter := 0; iter < 50; iter++ {
		c := &Client{send: make(chan []byte, 8)}

		// Consumer drains until the channel is closed.
		drained := make(chan struct{})
		go func() {
			for range c.send { //nolint:revive
			}
			close(drained)
		}()

		var wg sync.WaitGroup
		// Many concurrent senders.
		for i := 0; i < 20; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for j := 0; j < 200; j++ {
					c.trySend([]byte("msg"))
				}
			}()
		}
		// Several concurrent closers (closeSend must be idempotent).
		for i := 0; i < 4; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				c.closeSend()
			}()
		}
		wg.Wait()
		c.closeSend() // extra idempotent close
		<-drained
	}
}

// TestTrySendAfterClose verifies trySend never panics and reports false once the
// client is closed.
func TestTrySendAfterClose(t *testing.T) {
	c := &Client{send: make(chan []byte, 1)}
	c.closeSend()
	if c.trySend([]byte("x")) {
		t.Fatal("trySend should return false after closeSend")
	}
	// Double close must not panic.
	c.closeSend()
}

// TestTrySendFullBuffer verifies trySend is non-blocking and returns false when
// the buffer is full (the condition that triggers hub eviction).
func TestTrySendFullBuffer(t *testing.T) {
	c := &Client{send: make(chan []byte, 2)}
	if !c.trySend([]byte("a")) || !c.trySend([]byte("b")) {
		t.Fatal("first two sends should succeed")
	}
	if c.trySend([]byte("c")) {
		t.Fatal("third send should fail on a full buffer")
	}
}
