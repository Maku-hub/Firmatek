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

// MessageType defines the type of a message
type MessageType string

const (
	MessageTypeText        MessageType = "text"
	MessageTypeCodeSnippet MessageType = "code_snippet"
	MessageTypeFileInline  MessageType = "file_inline"
	MessageTypeFileRef     MessageType = "file_ref"
	MessageTypeSystem      MessageType = "system"
)

type Message struct {
	ID        string       `json:"id"`
	ChannelID string       `json:"channel_id"`
	SenderID  string       `json:"sender_id"`
	Sender    *User        `json:"sender,omitempty"`
	Type      MessageType  `json:"type"`
	Content   string       `json:"content"`
	Metadata  *MessageMeta `json:"metadata,omitempty"`
	CreatedAt time.Time    `json:"created_at"`
	// ClientID is the sender's own ID for the message, echoed back so the
	// sending app can match it with the copy it is waiting for.
	ClientID string `json:"client_id,omitempty"`
}

// ErrorPayload describes a rejected frame. ClientID is set when the frame
// was a chat message, so the sender knows which one failed.
type ErrorPayload struct {
	Message  string `json:"message"`
	ClientID string `json:"client_id,omitempty"`
}

// MessageMeta holds extra data that depends on the message type.
type MessageMeta struct {
	// Code
	Language string `json:"language,omitempty"`
	Filename string `json:"filename,omitempty"`

	// Inline file (small image/screenshot)
	MimeType  string `json:"mime_type,omitempty"`
	SizeBytes int64  `json:"size_bytes,omitempty"`
	Width     int    `json:"width,omitempty"`
	Height    int    `json:"height,omitempty"`

	// File stored in the offline buffer
	FileID    string `json:"file_id,omitempty"`
	OrigName  string `json:"orig_name,omitempty"`
	SHA256    string `json:"sha256,omitempty"`
	ExpiresAt string `json:"expires_at,omitempty"`
}

// --- WebSocket message protocol ---

// WSMessageType identifies a WebSocket event.
type WSMessageType string

const (
	// Chat
	WSTypeChatMessage WSMessageType = "chat_message"
	// WSTypeMessageAck confirms to the sending connection that its message
	// was stored. The payload is the stored Message, including client_id.
	WSTypeMessageAck WSMessageType = "message_ack"

	// Statuses
	WSTypeUserStatus   WSMessageType = "user_status"
	WSTypeTyping       WSMessageType = "typing"
	WSTypeUserNew      WSMessageType = "user_new"      // new user in the system
	WSTypeChannelAdded WSMessageType = "channel_added" // user added to a channel

	// WebRTC signaling
	WSTypeRTCOffer     WSMessageType = "rtc_offer"
	WSTypeRTCAnswer    WSMessageType = "rtc_answer"
	WSTypeICECandidate WSMessageType = "ice_candidate"
	WSTypeRTCDecline   WSMessageType = "rtc_decline"

	// Heartbeat (application-level keepalive)
	WSTypePing WSMessageType = "ping"
	WSTypePong WSMessageType = "pong"

	// Errors
	WSTypeError WSMessageType = "error"
)

// WSMessage is the envelope of every WebSocket frame.
type WSMessage struct {
	Type      WSMessageType `json:"type"`
	Payload   interface{}   `json:"payload"`
	SenderID  string        `json:"sender_id,omitempty"`
	TargetID  string        `json:"target_id,omitempty"` // for P2P signaling
	ChannelID string        `json:"channel_id,omitempty"`
}

// Payload for a user status update
type UserStatusPayload struct {
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name"`
	Online      bool   `json:"online"`
	LastSeen    string `json:"last_seen,omitempty"`
}
