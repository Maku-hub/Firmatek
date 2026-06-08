export interface User {
  id: string
  username: string
  display_name: string
  avatar_color: string
  online: boolean
  last_seen: string
}

export interface Channel {
  id: string
  name: string
  is_direct: boolean
  created_by: string
  created_at: string
  members?: User[]
}

export type MessageType = 'text' | 'code_snippet' | 'file_inline' | 'file_ref' | 'system'

export interface MessageMeta {
  // Kod
  language?: string
  filename?: string
  // Plik inline (mały obraz/screen)
  mime_type?: string
  size_bytes?: number
  width?: number
  height?: number
  // Plik offline
  file_id?: string
  orig_name?: string
  sha256?: string
  expires_at?: string
}

export interface Message {
  id: string
  channel_id: string
  sender_id: string
  sender?: User
  type: MessageType
  content: string
  metadata?: MessageMeta
  created_at: string
  delivered: boolean
}

// ─── WebSocket protocol ───────────────────────────────────────────────────────

export type WSMessageType =
  | 'chat_message'
  | 'message_ack'
  | 'user_status'
  | 'typing'
  | 'user_new'
  | 'channel_added'
  | 'rtc_offer'
  | 'rtc_answer'
  | 'ice_candidate'
  | 'rtc_decline'
  | 'error'

export interface WSMessage {
  type: WSMessageType
  payload: unknown
  sender_id?: string
  target_id?: string
  channel_id?: string
}

export interface UserStatusPayload {
  user_id: string
  display_name: string
  online: boolean
  last_seen?: string
}
