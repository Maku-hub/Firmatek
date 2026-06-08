package hub

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"firmatek/server/internal/cache"
	"firmatek/server/internal/models"
	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 512 * 1024 // 512KB – duże wiadomości to pliki, nie inline
)

// Client – reprezentuje jedno połączenie WebSocket
type Client struct {
	UserID      string
	Username    string
	DisplayName string

	hub  *Hub
	conn *websocket.Conn
	send chan []byte

	// Zależności potrzebne do obsługi wiadomości
	cache         *cache.Cache
	messageRouter func(client *Client, msg *models.WSMessage)
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

// ReadPump – odbiera wiadomości od klienta
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
				fmt.Printf("[WS] Nieoczekiwane zamknięcie (%s): %v\n", c.UserID, err)
			}
			break
		}

		var msg models.WSMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			c.sendError("Nieprawidłowy format wiadomości")
			continue
		}
		msg.SenderID = c.UserID

		c.messageRouter(c, &msg)
	}
}

// WritePump – wysyła wiadomości do klienta
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

			// Opróżnij bufor w jednym write
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
