package hub

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"firmatek/server/internal/cache"
	"firmatek/server/internal/models"
	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 512 * 1024 // 512KB – large messages are files, not inline content
)

// Client – represents a single WebSocket connection
type Client struct {
	UserID      string
	Username    string
	DisplayName string

	hub  *Hub
	conn *websocket.Conn
	send chan []byte

	// Guards send/close so the channel is never written to or closed twice.
	mu     sync.Mutex
	closed bool

	// Dependencies needed to handle messages
	cache         *cache.Cache
	messageRouter func(client *Client, msg *models.WSMessage)
}

// trySend performs a non-blocking send on the client's channel.
// Returns false if the client is already closed or its buffer is full.
func (c *Client) trySend(data []byte) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return false
	}
	select {
	case c.send <- data:
		return true
	default:
		return false
	}
}

// closeSend closes the send channel exactly once. Safe to call from multiple
// goroutines and multiple times.
func (c *Client) closeSend() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	close(c.send)
}

func NewClient(
	hub *Hub,
	conn *websocket.Conn,
	userID, username, displayName string,
	c *cache.Cache,
	router func(client *Client, msg *models.WSMessage),
) *Client {
	return &Client{
		UserID:        userID,
		Username:      username,
		DisplayName:   displayName,
		hub:           hub,
		conn:          conn,
		send:          make(chan []byte, 256),
		cache:         c,
		messageRouter: router,
	}
}

// ReadPump – receives messages from the client
func (c *Client) ReadPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
		_ = c.cache.RefreshOnlineTTL(context.Background(), c.UserID)
		return nil
	})

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				fmt.Printf("[WS] Unexpected close (%s): %v\n", c.UserID, err)
			}
			break
		}

		var msg models.WSMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			c.sendError("Invalid message format")
			continue
		}
		msg.SenderID = c.UserID

		c.messageRouter(c, &msg)
	}
}

// WritePump – sends messages to the client
func (c *Client) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			_, _ = w.Write(message)

			// Flush the buffer in a single write
			n := len(c.send)
			for i := 0; i < n; i++ {
				_, _ = w.Write([]byte{'\n'})
				_, _ = w.Write(<-c.send)
			}
			if err := w.Close(); err != nil {
				return
			}

		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) sendError(msg string) {
	errMsg := &models.WSMessage{
		Type:    models.WSTypeError,
		Payload: map[string]string{"message": msg},
	}
	data, _ := json.Marshal(errMsg)
	select {
	case c.send <- data:
	default:
	}
}
