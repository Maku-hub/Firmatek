package hub

import (
	"testing"
	"time"

	"firmatek/server/internal/models"
)

func newTestHub() *Hub {
	return &Hub{
		clients:    make(map[string]map[*Client]struct{}),
		register:   make(chan *Client, 8),
		unregister: make(chan *Client, 8),
		send:       make(chan *targetedMessage, 8),
	}
}

func addConn(h *Hub, userID string) *Client {
	c := &Client{UserID: userID, hub: h, send: make(chan []byte, 8)}
	if h.clients[userID] == nil {
		h.clients[userID] = make(map[*Client]struct{})
	}
	h.clients[userID][c] = struct{}{}
	return c
}

func TestUserStaysOnlineWhileAnySessionIsOpen(t *testing.T) {
	h := newTestHub()
	laptop := addConn(h, "u1")
	desktop := addConn(h, "u1")

	h.drop(laptop)
	if !h.IsOnline("u1") {
		t.Fatal("user went offline although a second session is still open")
	}
	h.drop(laptop) // dropping twice must be harmless
	h.drop(desktop)
	if h.IsOnline("u1") {
		t.Fatal("user still online after the last session closed")
	}
}

func TestSendToUserReachesEverySession(t *testing.T) {
	h := newTestHub()
	a := addConn(h, "u1")
	b := addConn(h, "u1")
	other := addConn(h, "u2")
	go h.Run()

	h.SendToUser("u1", &models.WSMessage{Type: models.WSTypeChatMessage})

	for name, c := range map[string]*Client{"first": a, "second": b} {
		select {
		case <-c.send:
		case <-time.After(time.Second):
			t.Fatalf("%s session did not receive the message", name)
		}
	}
	select {
	case <-other.send:
		t.Fatal("message leaked to another user")
	default:
	}
}

func TestOnlyChatAndInvitesAreQueued(t *testing.T) {
	for typ, want := range map[models.WSMessageType]bool{
		models.WSTypeChatMessage:  true,
		models.WSTypeChannelAdded: true,
		models.WSTypeRTCOffer:     false,
		models.WSTypeICECandidate: false,
		models.WSTypeTyping:       false,
		models.WSTypePong:         false,
	} {
		if got := isDurable(typ); got != want {
			t.Errorf("isDurable(%s) = %v, want %v", typ, got, want)
		}
	}
}
