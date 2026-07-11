package hub

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"firmatek/server/internal/cache"
	"firmatek/server/internal/models"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Hub manages all active WebSocket connections
type Hub struct {
	mu      sync.RWMutex
	clients map[string]*Client // userID → Client

	register   chan *Client
	unregister chan *Client
	send       chan *targetedMessage

	cache *cache.Cache
	db    *pgxpool.Pool
}

type targetedMessage struct {
	targetUserID string
	data         []byte
}

func NewHub(c *cache.Cache, db interface{ GetPool() *pgxpool.Pool }) *Hub {
	return &Hub{
		clients:    make(map[string]*Client),
		register:   make(chan *Client, 32),
		unregister: make(chan *Client, 32),
		send:       make(chan *targetedMessage, 256),
		cache:      c,
		db:         db.GetPool(),
	}
}

// Run – the hub's main loop, started in a goroutine
func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client.UserID] = client
			h.mu.Unlock()

			ctx := context.Background()
			_ = h.cache.SetUserOnline(ctx, client.UserID)

			// Deliver any queued messages
			go h.deliverOfflineMessages(client)

			// Broadcast: this user is online
			h.broadcastUserStatus(client.UserID, client.DisplayName, true, time.Time{})
			fmt.Printf("[Hub] Registered: %s (%s)\n", client.DisplayName, client.UserID)

		case client := <-h.unregister:
			h.mu.Lock()
			removed := false
			if existing, ok := h.clients[client.UserID]; ok && existing == client {
				delete(h.clients, client.UserID)
				removed = true
			}
			h.mu.Unlock()

			client.closeSend()

			// If a newer connection already replaced this one, the user is still
			// online – don't flip their status or last_seen.
			if !removed {
				fmt.Printf("[Hub] Stale connection closed (replaced): %s\n", client.UserID)
				continue
			}

			ctx := context.Background()
			_ = h.cache.SetUserOffline(ctx, client.UserID)

			// Update last_seen in the database
			now := time.Now()
			if h.db != nil {
				_, _ = h.db.Exec(ctx, `UPDATE users SET last_seen=$1 WHERE id=$2`, now, client.UserID)
			}

			// Broadcast: offline with the current timestamp
			h.broadcastUserStatus(client.UserID, client.DisplayName, false, now)
			fmt.Printf("[Hub] Unregistered: %s (%s)\n", client.DisplayName, client.UserID)

		case msg := <-h.send:
			h.mu.RLock()
			client, online := h.clients[msg.targetUserID]
			h.mu.RUnlock()

			if online && !client.trySend(msg.data) {
				// Buffer full (or already closed) – drop the client so a stuck
				// connection cannot block the hub. closeSend() is idempotent.
				h.mu.Lock()
				if existing, ok := h.clients[msg.targetUserID]; ok && existing == client {
					delete(h.clients, msg.targetUserID)
				}
				h.mu.Unlock()
				client.closeSend()
				fmt.Printf("[Hub] Evicted slow client (buffer full): %s\n", client.UserID)
			}
		}
	}
}

// SendToUser – sends a message to a specific user
// If the user is offline, the message is queued in Redis
func (h *Hub) SendToUser(userID string, msg *models.WSMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	h.mu.RLock()
	_, online := h.clients[userID]
	h.mu.RUnlock()

	if online {
		h.send <- &targetedMessage{targetUserID: userID, data: data}
	} else {
		// Queue in Redis for the offline user
		_ = h.cache.EnqueueOfflineMessage(context.Background(), userID, msg)
	}
}

// SendToAll – broadcasts to all connected clients
func (h *Hub) SendToAll(msg *models.WSMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, client := range h.clients {
		client.trySend(data)
	}
}

// SendToChannel – sends to all members of a channel (from the provided list)
func (h *Hub) SendToChannel(memberIDs []string, msg *models.WSMessage, excludeUserID string) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, uid := range memberIDs {
		if uid == excludeUserID {
			continue
		}
		if client, ok := h.clients[uid]; ok {
			client.trySend(data)
		}
	}
}

// Register – registers a client with the hub (public API)
func (h *Hub) Register(client *Client) {
	h.register <- client
}

// IsOnline – whether the user is currently connected
func (h *Hub) IsOnline(userID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	_, ok := h.clients[userID]
	return ok
}

// OnlineUsers – returns a slice of the currently online user IDs
func (h *Hub) OnlineUsers() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()

	ids := make([]string, 0, len(h.clients))
	for id := range h.clients {
		ids = append(ids, id)
	}
	return ids
}

func (h *Hub) broadcastUserStatus(userID, displayName string, online bool, lastSeen time.Time) {
	payload := models.UserStatusPayload{
		UserID:      userID,
		DisplayName: displayName,
		Online:      online,
	}
	if !lastSeen.IsZero() {
		ls := lastSeen.Format(time.RFC3339)
		payload.LastSeen = ls
	}
	msg := &models.WSMessage{
		Type:    models.WSTypeUserStatus,
		Payload: payload,
	}
	h.SendToAll(msg)
}

func (h *Hub) deliverOfflineMessages(client *Client) {
	msgs, err := h.cache.DequeueOfflineMessages(context.Background(), client.UserID)
	if err != nil || len(msgs) == 0 {
		return
	}

	for _, data := range msgs {
		if !client.trySend(data) {
			return
		}
	}
	fmt.Printf("[Hub] Delivered %d queued messages to %s\n", len(msgs), client.UserID)
}
