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

// Hub zarządza wszystkimi aktywnymi połączeniami WebSocket
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

// Run – główna pętla huba, uruchamiana w goroutine
func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client.UserID] = client
			h.mu.Unlock()

			ctx := context.Background()
			_ = h.cache.SetUserOnline(ctx, client.UserID)

			// Dostarczamy zakolejkowane wiadomości
			go h.deliverOfflineMessages(client)

			// Broadcast: ten użytkownik jest online
			h.broadcastUserStatus(client.UserID, client.DisplayName, true, time.Time{})
			fmt.Printf("[Hub] Zarejestrowano: %s (%s)\n", client.DisplayName, client.UserID)

		case client := <-h.unregister:
			h.mu.Lock()
			if existing, ok := h.clients[client.UserID]; ok && existing == client {
				delete(h.clients, client.UserID)
			}
			h.mu.Unlock()

			ctx := context.Background()
			_ = h.cache.SetUserOffline(ctx, client.UserID)
			close(client.send)

			// Zaktualizuj last_seen w bazie
			now := time.Now()
			if h.db != nil {
				_, _ = h.db.Exec(ctx, `UPDATE users SET last_seen=$1 WHERE id=$2`, now, client.UserID)
			}

			// Broadcast: offline z aktualnym timestampem
			h.broadcastUserStatus(client.UserID, client.DisplayName, false, now)
			fmt.Printf("[Hub] Wyrejestrowano: %s (%s)\n", client.DisplayName, client.UserID)

		case msg := <-h.send:
			h.mu.RLock()
			client, online := h.clients[msg.targetUserID]
			h.mu.RUnlock()

			if online {
				select {
				case client.send <- msg.data:
				default:
					// Bufor klienta pełny – zamknij
					h.mu.Lock()
					delete(h.clients, msg.targetUserID)
					h.mu.Unlock()
					close(client.send)
				}
			}
		}
	}
}

// SendToUser – wysyła wiadomość do konkretnego użytkownika
// Jeśli offline, kolejkuje w Redis
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
		// Kolejkuj w Redis dla offline użytkownika
		_ = h.cache.EnqueueOfflineMessage(context.Background(), userID, msg)
	}
}

// SendToAll – broadcast do wszystkich połączonych klientów
func (h *Hub) SendToAll(msg *models.WSMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, client := range h.clients {
		select {
		case client.send <- data:
		default:
		}
	}
}

// SendToChannel – wysyła do wszystkich członków kanału (przekazana lista)
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
			select {
			case client.send <- data:
			default:
			}
		}
	}
}

// Register – rejestruje klienta w hubie (publiczne API)
func (h *Hub) Register(client *Client) {
	h.register <- client
}

// IsOnline – czy użytkownik jest aktualnie połączony
func (h *Hub) IsOnline(userID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	_, ok := h.clients[userID]
	return ok
}

// OnlineUsers – zwraca slice aktualnie online userIDs
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
		select {
		case client.send <- data:
		default:
			return
		}
	}
	fmt.Printf("[Hub] Dostarczono %d zakolejkowanych wiadomości dla %s\n", len(msgs), client.UserID)
}
