import type { User, Channel, Message } from '../types'

const SERVER_KEY = 'firmatek_server'
const TOKEN_KEY = 'firmatek_token'
const REQUEST_TIMEOUT = 15_000

let SERVER_URL = localStorage.getItem(SERVER_KEY) || 'http://localhost:8080'

export function setServerURL(url: string) {
  SERVER_URL = url.trim().replace(/\/+$/, '')
  localStorage.setItem(SERVER_KEY, SERVER_URL)
}
export function getServerURL(): string { return SERVER_URL }
export function getToken(): string { return localStorage.getItem(TOKEN_KEY) || '' }
function setToken(token: string) { localStorage.setItem(TOKEN_KEY, token) }

/** Fired on window when the server rejects the stored session. */
export const SESSION_EXPIRED_EVENT = 'firmatek:session-expired'

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(`${SERVER_URL}/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })
  } catch {
    throw new ApiError('Cannot reach the server', 0)
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    // A 401 on an authenticated call means the session is gone (expired
    // token, deleted account). Login attempts report their own 401s.
    if (res.status === 401 && token && !path.startsWith('/auth/')) {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    }
    throw new ApiError(err.error || 'Server error', res.status)
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
  setToken(data.token)
  return data
}

export async function register(username: string, displayName: string, password: string) {
  const data = await request<{ token: string; user_id: string; user: User }>('POST', '/auth/register', {
    username, display_name: displayName, password,
  })
  setToken(data.token)
  return data
}

/** Swaps the current token for a fresh one. Tokens last 24 hours. */
export async function refreshToken(): Promise<User> {
  const data = await request<{ token: string; user: User }>('POST', '/auth/refresh')
  setToken(data.token)
  return data.user
}

export function logout() { localStorage.removeItem(TOKEN_KEY) }

export async function getMe(): Promise<User> { return request<User>('GET', '/me') }
export async function getUsers(): Promise<User[]> { return request<User[]>('GET', '/users') }
export async function getChannels(): Promise<Channel[]> { return request<Channel[]>('GET', '/channels') }

export async function createChannel(name: string, members: string[] = []) {
  return request<{ channel_id: string; name: string; channel: Channel }>('POST', '/channels', { name, members })
}

export async function createDirectChannel(targetId: string) {
  return request<{ channel_id: string; existing: boolean; channel?: Channel }>(
    'POST', `/channels/direct/${encodeURIComponent(targetId)}`)
}

export async function getChannelMembers(channelId: string): Promise<User[]> {
  return request<User[]>('GET', `/channels/${encodeURIComponent(channelId)}/members`)
}

export async function addChannelMember(channelId: string, userId: string) {
  return request('POST', `/channels/${encodeURIComponent(channelId)}/members`, { user_id: userId })
}

export async function leaveChannel(channelId: string) {
  return request('DELETE', `/channels/${encodeURIComponent(channelId)}/leave`)
}

export const PAGE_SIZE = 50

/**
 * Loads one page of history. Pass the oldest loaded message to get the page
 * before it.
 */
export async function getMessages(channelId: string, before?: Message, limit = PAGE_SIZE): Promise<Message[]> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (before) {
    params.set('before', before.created_at)
    params.set('before_id', before.id)
  }
  return request<Message[]>('GET', `/channels/${encodeURIComponent(channelId)}/messages?${params}`)
}

export interface SearchResult extends Message {
  channel_name: string
  is_direct: boolean
}

export async function searchMessages(query: string, limit = 50): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) })
  return request<SearchResult[]>('GET', `/messages/search?${params}`)
}

/**
 * Returns STUN/TURN servers. TURN credentials are short-lived and minted by
 * the server, so nothing secret is bundled with the client.
 */
export async function getIceServers(): Promise<RTCIceServer[]> {
  const res = await request<{ ice_servers: RTCIceServer[] }>('GET', '/turn-credentials')
  return res.ice_servers
}

export function getWsURL(): string {
  const wsBase = SERVER_URL.replace(/^http/, 'ws')
  return `${wsBase}/ws?token=${encodeURIComponent(getToken())}`
}
