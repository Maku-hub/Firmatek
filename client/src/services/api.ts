import type { User, Channel, Message } from '../types'

let SERVER_URL = localStorage.getItem('firmatek_server') || 'http://localhost:8080'

export function setServerURL(url: string) {
  SERVER_URL = url.replace(/\/$/, '')
  localStorage.setItem('firmatek_server', SERVER_URL)
}
export function getServerURL(): string { return SERVER_URL }
export function getToken(): string { return localStorage.getItem('firmatek_token') || '' }

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SERVER_URL}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || 'Server error')
  }
  return res.json()
}

export interface AuthConfig {
  ldap_enabled: boolean
  registration_enabled: boolean
  app_name: string
}

export async function getAuthConfig(): Promise<AuthConfig> {
  return request<AuthConfig>('GET', '/auth/config')
}

export async function login(username: string, password: string) {
  const data = await request<{ token: string; user: User }>('POST', '/auth/login', { username, password })
  localStorage.setItem('firmatek_token', data.token)
  return data
}

export async function register(username: string, displayName: string, password: string) {
  const data = await request<{ token: string; user_id: string; user: User }>('POST', '/auth/register', {
    username, display_name: displayName, password,
  })
  localStorage.setItem('firmatek_token', data.token)
  return data
}

export function logout() { localStorage.removeItem('firmatek_token') }

export async function getMe(): Promise<User> { return request<User>('GET', '/me') }
export async function getUsers(): Promise<User[]> { return request<User[]>('GET', '/users') }
export async function getChannels(): Promise<Channel[]> { return request<Channel[]>('GET', '/channels') }

export async function createChannel(name: string, members: string[] = []) {
  return request<{ channel_id: string; name: string }>('POST', '/channels', { name, members })
}

export async function createDirectChannel(targetId: string) {
  return request<{ channel_id: string; existing: boolean }>('POST', `/channels/direct/${targetId}`)
}

export async function getChannelMembers(channelId: string): Promise<User[]> {
  return request<User[]>('GET', `/channels/${channelId}/members`)
}

export async function addChannelMember(channelId: string, userId: string) {
  return request('POST', `/channels/${channelId}/members`, { user_id: userId })
}

export async function leaveChannel(channelId: string) {
  return request('DELETE', `/channels/${channelId}/leave`)
}

// getMessages returns a page of messages (default 50). Pass `before` (the
// oldest loaded message's created_at) to load the previous page.
export async function getMessages(channelId: string, before?: string, limit = 50): Promise<Message[]> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (before) params.set('before', before)
  return request<Message[]>('GET', `/channels/${channelId}/messages?${params.toString()}`)
}

export interface SearchResult extends Message {
  channel_name: string
  is_direct: boolean
}

export async function searchMessages(query: string, limit = 50): Promise<SearchResult[]> {
  return request<SearchResult[]>('GET', `/messages/search?q=${encodeURIComponent(query)}&limit=${limit}`)
}

export interface IceServersResponse {
  ice_servers: RTCIceServer[]
}

// Fetches short-lived ICE/TURN servers from the server (credentials are
// time-limited HMAC tokens, not a static secret baked into the client).
export async function getIceServers(): Promise<RTCIceServer[]> {
  const res = await request<IceServersResponse>('GET', '/turn-credentials')
  return res.ice_servers
}

export function getWsURL(): string {
  const wsBase = SERVER_URL.replace(/^http/, 'ws')
  return `${wsBase}/ws?token=${encodeURIComponent(getToken())}`
}
