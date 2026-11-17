package hub

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"firmatek/server/internal/cache"
	"firmatek/server/internal/models"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Hub tracks live WebSocket connections. A user may be connected from several
// devices at once, so each user ID maps to a set of clients.
type Hub struct {
	mu      sync.RWMutex
	clients map[string]map[*Client]struct{}

	register   chan *Client
	unregister chan *Client
	send       chan *targetedMessage

	cache *cache.Cache
	db    *pgxpool.Pool
}

type targetedMessage struct {
	userID  string
	data    []byte
	durable bool // queue in Redis when the user has no live connection
}

func NewHub(c *cache.Cache, db interface{ GetPool() *pgxpool.Pool }) *Hub {
	return &Hub{
		clients:    make(map[string]map[*Client]struct{}),
		register:   make(chan *Client, 32),
		unregister: make(chan *Client, 32),
		send:       make(chan *targetedMessage, 256),
		cache:      c,
		db:         db.GetPool(),
	}
}

// Run is the hub's event loop. It must run in its own goroutine.
func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			conns := h.clients[client.UserID]
			firstConn := len(conns) == 0
			if conns == nil {
				conns = make(map[*Client]struct{})
				h.clients[client.UserID] = conns
			}
			conns[client] = struct{}{}
			h.mu.Unlock()

			go h.deliverOfflineMessages(client)

			if firstConn {
				h.broadcastUserStatus(client.UserID, client.DisplayName, true, time.Time{})
			}
			log.Printf("hub: %s connected (%d session(s))", client.UserID, len(conns))

		case client := <-h.unregister:
			h.drop(client)

		case msg := <-h.send:
			h.mu.RLock()
			conns := make([]*Client, 0, len(h.clients[msg.userID]))
			for c := range h.clients[msg.userID] {
				conns = append(conns, c)
			}
			h.mu.RUnlock()

			if len(conns) == 0 {
				if msg.durable {
					if err := h.cache.EnqueueOfflineMessage(context.Background(), msg.userID, msg.data); err != nil {
						log.Printf("hub: queue offline message for %s: %v", msg.userID, err)
					}
				}
				continue
			}
			for _, c := range conns {
				if !c.trySend(msg.data) {
					// Buffer full: drop the connection rather than let one stuck
					// client stall the hub. The client reconnects and reloads.
					log.Printf("hub: evicting slow client %s", c.UserID)
					h.drop(c)
				}
			}
		}
	}
}

// drop removes a single connection. When it was the user's last one the user
// is marked offline and everyone is notified. Safe to call more than once for
// the same client.
func (h *Hub) drop(client *Client) {
	h.mu.Lock()
	conns, ok := h.clients[client.UserID]
	_, present := conns[client]
	lastConn := false
	if ok && present {
		delete(conns, client)
		if len(conns) == 0 {
			delete(h.clients, client.UserID)
			lastConn = true
		}
	}
	h.mu.Unlock()

	client.closeSend()
	if !lastConn {
		return
	}

	now := time.Now()
	if h.db != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if _, err := h.db.Exec(ctx, `UPDATE users SET last_seen=$1 WHERE id=$2`, now, client.UserID); err != nil {
			log.Printf("hub: update last_seen for %s: %v", client.UserID, err)
		}
		cancel()
	}
	h.broadcastUserStatus(client.UserID, client.DisplayName, false, now)
	log.Printf("hub: %s disconnected", client.UserID)
}

// SendToUser delivers msg to every connection of the user. Chat messages and
// channel invitations are queued for later if the user is offline; transient
// events (typing, WebRTC signalling) are dropped.
func (h *Hub) SendToUser(userID string, msg *models.WSMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("hub: marshal %s: %v", msg.Type, err)
		return
	}
	h.send <- &targetedMessage{userID: userID, data: data, durable: isDurable(msg.Type)}
}

func isDurable(t models.WSMessageType) bool {
	return t == models.WSTypeChatMessage || t == models.WSTypeChannelAdded
}

// SendToAll broadcasts to every live connection. Best effort: a client with a
// full buffer simply misses the event.
func (h *Hub) SendToAll(msg *models.WSMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, conns := range h.clients {
		for c := range conns {
			c.trySend(data)
		}
	}
}

// SendToChannel sends a transient event to the live connections of the given
// members, skipping excludeUserID.
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
		for c := range h.clients[uid] {
			c.trySend(data)
		}
	}
}

func (h *Hub) Register(client *Client) {
	h.register <- client
}

func (h *Hub) IsOnline(userID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients[userID]) > 0
}

func (h *Hub) broadcastUserStatus(userID, displayName string, online bool, lastSeen time.Time) {
	payload := models.UserStatusPayload{
		UserID:      userID,
		DisplayName: displayName,
		Online:      online,
	}
	if !lastSeen.IsZero() {
		payload.LastSeen = lastSeen.Format(time.RFC3339)
	}
	h.SendToAll(&models.WSMessage{Type: models.WSTypeUserStatus, Payload: payload})
}

func (h *Hub) deliverOfflineMessages(client *Client) {
	msgs, err := h.cache.DequeueOfflineMessages(context.Background(), client.UserID)
	if err != nil {
		log.Printf("hub: read offline queue for %s: %v", client.UserID, err)
		return
	}
	for i, data := range msgs {
		if !client.trySend(data) {
			// The client loads channel history on its own, so nothing is lost
			// permanently, but it is worth knowing about.
			log.Printf("hub: %d queued message(s) for %s not delivered", len(msgs)-i, client.UserID)
			return
		}
	}
	if len(msgs) > 0 {
		log.Printf("hub: delivered %d queued message(s) to %s", len(msgs), client.UserID)
	}
}
