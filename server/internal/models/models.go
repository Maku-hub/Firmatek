package models

import "time"

type User struct {
	ID          string    `json:"id"`
	Username    string    `json:"username"`
	DisplayName string    `json:"display_name"`
	AvatarColor string    `json:"avatar_color"`
	CreatedAt   time.Time `json:"created_at"`
	LastSeen    time.Time `json:"last_seen"`
	Online      bool      `json:"online"`
}

type Channel struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	IsDirect  bool      `json:"is_direct"`
	CreatedBy string    `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
	Members   []User    `json:"members,omitempty"`
}

// MessageType określa typ wiadomości
type MessageType string

const (
	MessageTypeText        MessageType = "text"
	MessageTypeCodeSnippet MessageType = "code_snippet"
	MessageTypeFileInline  MessageType = "file_inline"
	MessageTypeFileRef     MessageType = "file_ref"
	MessageTypeSystem      MessageType = "system"
)

type Message struct {
	ID        string          `json:"id"`
	ChannelID string          `json:"channel_id"`
	SenderID  string          `json:"sender_id"`
	Sender    *User           `json:"sender,omitempty"`
	Type      MessageType     `json:"type"`
	Content   string          `json:"content"`
	Metadata  *MessageMeta    `json:"metadata,omitempty"`
	CreatedAt time.Time       `json:"created_at"`
	Delivered bool            `json:"delivered"`
}

// MessageMeta – dodatkowe dane zależne od typu wiadomości
type MessageMeta struct {
	// Kod
	Language string `json:"language,omitempty"`
	Filename string `json:"filename,omitempty"`

	// Plik inline (mały obraz/screen)
	MimeType  string `json:"mime_type,omitempty"`
	SizeBytes int64  `json:"size_bytes,omitempty"`
	Width     int    `json:"width,omitempty"`
	Height    int    `json:"height,omitempty"`

	// Plik w buforze offline
	FileID      string `json:"file_id,omitempty"`
	OrigName    string `json:"orig_name,omitempty"`
	SHA256      string `json:"sha256,omitempty"`
	ExpiresAt   string `json:"expires_at,omitempty"`
}

// --- WebSocket message protocol ---

// WSMessageType – typy wiadomości WebSocket
type WSMessageType string

const (
	// Chat
	WSTypeChatMessage  WSMessageType = "chat_message"
	WSTypeMessageAck   WSMessageType = "message_ack"

	// Statusy
	WSTypeUserStatus   WSMessageType = "user_status"
	WSTypeTyping       WSMessageType = "typing"
	WSTypeUserNew      WSMessageType = "user_new"        // nowy użytkownik w systemie
	WSTypeChannelAdded WSMessageType = "channel_added"   // użytkownik dodany do kanału

	// WebRTC signaling
	WSTypeRTCOffer     WSMessageType = "rtc_offer"
	WSTypeRTCAnswer    WSMessageType = "rtc_answer"
	WSTypeICECandidate WSMessageType = "ice_candidate"
	WSTypeRTCDecline   WSMessageType = "rtc_decline"

	// Błędy
	WSTypeError        WSMessageType = "error"
)

// WSMessage – format ramki WebSocket
type WSMessage struct {
	Type      WSMessageType `json:"type"`
	Payload   interface{}   `json:"payload"`
	SenderID  string        `json:"sender_id,omitempty"`
	TargetID  string        `json:"target_id,omitempty"` // dla P2P signaling
	ChannelID string        `json:"channel_id,omitempty"`
}

// Payload dla statusu użytkownika
type UserStatusPayload struct {
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name"`
	Online      bool   `json:"online"`
	LastSeen    string `json:"last_seen,omitempty"`
}
