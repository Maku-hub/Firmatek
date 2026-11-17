package hub

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"firmatek/server/internal/models"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 512 * 1024 // files go peer-to-peer, so frames stay small
	sendBuffer     = 256
)

// Client is a single WebSocket connection. One user can have several.
type Client struct {
	UserID      string
	Username    string
	DisplayName string

	hub  *Hub
	conn *websocket.Conn
	send chan []byte

	// mu guards send against concurrent close, so it is never written to or
	// closed after it has been closed.
	mu     sync.Mutex
	closed bool

	route func(client *Client, msg *models.WSMessage)
}

func NewClient(
	hub *Hub,
	conn *websocket.Conn,
	userID, username, displayName string,
	route func(client *Client, msg *models.WSMessage),
) *Client {
	return &Client{
		UserID:      userID,
		Username:    username,
		DisplayName: displayName,
		hub:         hub,
		conn:        conn,
		send:        make(chan []byte, sendBuffer),
		route:       route,
	}
}

// trySend queues data without blocking. It returns false if the connection
// is closed or its buffer is full.
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

// closeSend closes the send channel exactly once.
func (c *Client) closeSend() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	close(c.send)
}

// Send queues a message for this connection only.
func (c *Client) Send(msg *models.WSMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	c.trySend(data)
}

// SendError reports a problem with a frame the client sent.
func (c *Client) SendError(text string) {
	c.SendMessageError("", text)
}

// SendMessageError reports why a chat message with the given client ID was
// not accepted.
func (c *Client) SendMessageError(clientID, text string) {
	c.Send(&models.WSMessage{Type: models.WSTypeError, Payload: models.ErrorPayload{Message: text, ClientID: clientID}})
}

// ReadPump reads frames from the connection until it fails, then unregisters
// the client.
func (c *Client) ReadPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("ws: unexpected close for %s: %v", c.UserID, err)
			}
			return
		}

		var msg models.WSMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			c.SendError("invalid message format")
			continue
		}
		msg.SenderID = c.UserID
		c.route(c, &msg)
	}
}

// WritePump writes queued messages and keepalive pings to the connection.
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

			// Coalesce whatever else is already queued into the same frame;
			// the client splits on newlines.
			for n := len(c.send); n > 0; n-- {
				next, ok := <-c.send
				if !ok {
					break
				}
				_, _ = w.Write([]byte{'\n'})
				_, _ = w.Write(next)
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
