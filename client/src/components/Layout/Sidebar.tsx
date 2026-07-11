import { useState } from 'react'
import { useStore } from '../../store'
import { createChannel, createDirectChannel, getMessages, getChannelMembers, addChannelMember, leaveChannel } from '../../services/api'
import ConfirmDialog from '../UI/ConfirmDialog'
import { dmPartnerId } from '../../lib/dm'
import { t } from '../../i18n'
import type { User, Channel } from '../../types'

function formatLastSeen(lastSeen: string): string {
  if (!lastSeen) return t('time.offline')
  const diff = Date.now() - new Date(lastSeen).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return t('time.justNow')
  if (mins < 60) return t('time.minAgo', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('time.hoursAgo', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('time.daysAgo', { n: days })
  return t('time.longAgo')
}

interface Props {
  currentUser: User
  onLogout: () => void
  onOpenSettings: () => void
  appName: string
}

export default function Sidebar({ currentUser, onLogout, onOpenSettings, appName }: Props) {
  const { channels, users, activeChannelId, unread, setActiveChannel, addChannel, setMessages, clearUnread, removeChannel } = useStore()

  const [showNewChannel, setShowNewChannel] = useState(false)
  const [newChannelName, setNewChannelName] = useState('')
  const [selectedMembers, setSelectedMembers] = useState<string[]>([])
  const [tab, setTab] = useState<'channels' | 'users'>('channels')
  const [showMembersFor, setShowMembersFor] = useState<string | null>(null)
  const [channelMembers, setChannelMembers] = useState<User[]>([])
  const [showAddMember, setShowAddMember] = useState(false)

  // Confirmation dialogs
  const [confirmLogout, setConfirmLogout] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState<string | null>(null) // channelId

  const handleSelectChannel = async (channelId: string) => {
    setActiveChannel(channelId)
    clearUnread(channelId)
    setShowMembersFor(null)
    const msgs = await getMessages(channelId).catch(() => [])
    setMessages(channelId, msgs)
  }

  const handleCreateChannel = async () => {
    if (!newChannelName.trim()) return
    try {
      const res = await createChannel(newChannelName.trim(), selectedMembers)
      addChannel({ id: res.channel_id, name: res.name, is_direct: false, created_by: currentUser.id, created_at: new Date().toISOString() })
      handleSelectChannel(res.channel_id)
      setNewChannelName(''); setSelectedMembers([]); setShowNewChannel(false)
    } catch {}
  }

  const handleOpenDM = async (user: User) => {
    try {
      const res = await createDirectChannel(user.id)
      const existing = channels.find((c) => c.id === res.channel_id)
      if (!existing) addChannel({ id: res.channel_id, name: `dm:${currentUser.id}:${user.id}`, is_direct: true, created_by: currentUser.id, created_at: new Date().toISOString() })
      handleSelectChannel(res.channel_id)
      setTab('channels')
    } catch {}
  }

  const handleShowMembers = async (ch: Channel, e: React.MouseEvent) => {
    e.stopPropagation()
    if (showMembersFor === ch.id) { setShowMembersFor(null); return }
    const members = await getChannelMembers(ch.id).catch(() => [])
    setChannelMembers(members)
    setShowMembersFor(ch.id)
    setShowAddMember(false)
  }

  const handleAddMember = async (userId: string) => {
    if (!showMembersFor) return
    try {
      await addChannelMember(showMembersFor, userId)
      const members = await getChannelMembers(showMembersFor)
      setChannelMembers(members)
      setShowAddMember(false)
    } catch {}
  }

  const handleLeaveConfirmed = async () => {
    if (!confirmLeave) return
    try {
      await leaveChannel(confirmLeave)
      removeChannel(confirmLeave)
      if (activeChannelId === confirmLeave) setActiveChannel(null)
    } catch {}
    setConfirmLeave(null)
    setShowMembersFor(null)
  }

  const getDMUser = (ch: Channel): (typeof users)[string] | undefined => {
    if (!ch.is_direct) return undefined
    const otherId = dmPartnerId(ch.name, currentUser.id)
    return otherId ? users[otherId] : undefined
  }

  const publicChannels = channels.filter((c) => !c.is_direct)
  const dmChannels = channels.filter((c) => c.is_direct)
  const userList = Object.values(users).filter((u) => u.id !== currentUser.id)
  const membersInChannel = showMembersFor ? channelMembers.map((m) => m.id) : []
  const nonMembers = userList.filter((u) => !membersInChannel.includes(u.id))

  return (
    <>
      <div style={s.sidebar}>
        {/* Header */}
        <div style={s.header}>
          <span style={s.workspaceName}>{appName}</span>
        </div>

        <div style={s.tabs}>
          {(['channels', 'users'] as const).map((tabKey) => (
            <button key={tabKey} style={{ ...s.tabBtn, ...(tab === tabKey ? s.tabActive : {}) }} onClick={() => setTab(tabKey)}>
              {tabKey === 'channels' ? t('sidebar.channels') : t('sidebar.people')}
            </button>
          ))}
        </div>

        <div style={s.list}>
          {tab === 'channels' && <>
            <div style={s.section}>
              <div style={s.sectionHeader}>
                <span>{t('sidebar.channelsHeader')}</span>
                <button style={s.addBtn} onClick={() => setShowNewChannel(!showNewChannel)}>+</button>
              </div>

              {showNewChannel && (
                <div style={s.newChannelForm}>
                  <input style={s.input} value={newChannelName}
                    onChange={(e) => setNewChannelName(e.target.value)}
                    placeholder={t('sidebar.channelNamePlaceholder')} autoFocus
                    onKeyDown={(e) => e.key === 'Enter' && handleCreateChannel()} />
                  <div style={{ fontSize: 11, color: '#888', margin: '6px 0 4px' }}>{t('sidebar.addMembers')}</div>
                  <div style={{ maxHeight: 120, overflowY: 'auto' }}>
                    {userList.map((u) => (
                      <label key={u.id} style={s.checkRow}>
                        <input type="checkbox" checked={selectedMembers.includes(u.id)}
                          onChange={(e) => setSelectedMembers(prev =>
                            e.target.checked ? [...prev, u.id] : prev.filter(id => id !== u.id))} />
                        <span style={{ color: '#ccc', fontSize: 12 }}>{u.display_name}</span>
                      </label>
                    ))}
                  </div>
                  <button style={s.createBtn} onClick={handleCreateChannel}>{t('sidebar.createChannel')}</button>
                </div>
              )}

              {publicChannels.map((ch) => (
                <div key={ch.id}>
                  <div style={{ ...s.channelItem, ...(ch.id === activeChannelId ? s.channelActive : {}) }}
                    role="button" tabIndex={0}
                    onClick={() => handleSelectChannel(ch.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSelectChannel(ch.id) }}>
                    <span style={{ color: ch.id === activeChannelId ? '#fff' : '#aaa', fontSize: 14, flex: 1 }}>
                      # {ch.name}
                    </span>
                    <button style={s.infoBtn} onClick={(e) => handleShowMembers(ch, e)} title={t('sidebar.members')}>👥</button>
                    {(unread[ch.id] ?? 0) > 0 && <span style={s.badge}>{unread[ch.id]}</span>}
                  </div>

                  {showMembersFor === ch.id && (
                    <div style={s.memberPanel}>
                      <div style={{ color: '#888', fontSize: 11, marginBottom: 6 }}>{t('sidebar.membersHeader')}</div>
                      {channelMembers.map((m) => (
                        <div key={m.id} style={s.memberRow}>
                          <div style={{ width: 6, height: 6, borderRadius: '50%', background: m.online ? '#22c55e' : '#555', flexShrink: 0 }} />
                          <span style={{ color: '#ccc', fontSize: 12, flex: 1 }}>{m.display_name}</span>
                        </div>
                      ))}
                      <button style={s.addMemberBtn} onClick={() => setShowAddMember(!showAddMember)}>{t('sidebar.addPerson')}</button>
                      {showAddMember && nonMembers.map((u) => (
                        <div key={u.id} style={{ ...s.memberRow, cursor: 'pointer' }} onClick={() => handleAddMember(u.id)}>
                          <span style={{ color: '#6366f1', fontSize: 12 }}>+ {u.display_name}</span>
                        </div>
                      ))}
                      <button style={s.leaveBtn} onClick={() => setConfirmLeave(ch.id)}>{t('sidebar.leaveChannel')}</button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {dmChannels.length > 0 && (
              <div style={s.section}>
                <div style={s.sectionHeader}><span>{t('sidebar.directMessages')}</span></div>
                {dmChannels.map((ch) => {
                  const otherUser = getDMUser(ch)
                  return (
                    <div key={ch.id} style={{ ...s.channelItem, ...(ch.id === activeChannelId ? s.channelActive : {}) }}
                      role="button" tabIndex={0}
                      onClick={() => handleSelectChannel(ch.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleSelectChannel(ch.id) }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: otherUser?.online ? '#22c55e' : '#555', flexShrink: 0 }} />
                      <span style={{ color: ch.id === activeChannelId ? '#fff' : '#aaa', fontSize: 14, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {otherUser?.display_name ?? t('chat.directMessage')}
                      </span>
                      {(unread[ch.id] ?? 0) > 0 && <span style={s.badge}>{unread[ch.id]}</span>}
                    </div>
                  )
                })}
              </div>
            )}
          </>}

          {tab === 'users' && (
            <div style={s.section}>
              <div style={s.sectionHeader}><span>{t('sidebar.coworkers')}</span></div>
              {userList.map((user) => (
                <div key={user.id} style={s.userItem} role="button" tabIndex={0}
                  onClick={() => handleOpenDM(user)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleOpenDM(user) }}>
                  <div style={{ ...s.avatar, background: user.avatar_color }}>{(user.display_name?.[0] ?? '?').toUpperCase()}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: '#ddd', fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.display_name}</div>
                    <div style={{ color: '#666', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', display: 'inline-block', background: user.online ? '#22c55e' : '#555' }} />
                      {user.online ? t('sidebar.online') : formatLastSeen(user.last_seen)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={s.footer}>
          <div style={{ ...s.avatar, background: currentUser.avatar_color }}>{(currentUser.display_name?.[0] ?? '?').toUpperCase()}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: '#fff', fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentUser.display_name}</div>
            <div style={{ color: '#22c55e', fontSize: 11 }}>● {t('sidebar.online')}</div>
          </div>
          <button style={s.footerBtn} onClick={onOpenSettings} title={t('sidebar.settings')}>⚙</button>
          <button style={s.footerBtn} onClick={() => setConfirmLogout(true)} title={t('sidebar.logout')}>⏏</button>
        </div>
      </div>

      {confirmLogout && (
        <ConfirmDialog
          title={t('sidebar.logout')}
          message={t('sidebar.logoutConfirm')}
          confirmLabel={t('sidebar.logout')}
          cancelLabel={t('sidebar.cancel')}
          onConfirm={() => { setConfirmLogout(false); onLogout() }}
          onCancel={() => setConfirmLogout(false)}
        />
      )}

      {confirmLeave && (
        <ConfirmDialog
          title={t('sidebar.leaveTitle')}
          message={t('sidebar.leaveConfirm', { name: channels.find(c => c.id === confirmLeave)?.name ?? '' })}
          confirmLabel={t('sidebar.leave')}
          cancelLabel={t('sidebar.cancel')}
          danger
          onConfirm={handleLeaveConfirmed}
          onCancel={() => setConfirmLeave(null)}
        />
      )}
    </>
  )
}

const s: Record<string, React.CSSProperties> = {
  sidebar: { width: 240, background: '#13131c', display: 'flex', flexDirection: 'column', height: '100%', borderRight: '1px solid #222', flexShrink: 0 },
  header: { padding: '14px 16px 8px', borderBottom: '1px solid #1e1e2e' },
  workspaceName: { color: '#fff', fontWeight: 700, fontSize: 14 },
  tabs: { display: 'flex', padding: '8px 8px 0' },
  tabBtn: { flex: 1, padding: '6px 0', border: 'none', cursor: 'pointer', background: 'transparent', color: '#666', fontSize: 12, borderRadius: 6 },
  tabActive: { background: '#1e1e30', color: '#fff' },
  list: { flex: 1, overflowY: 'auto', padding: '8px 0' },
  section: { marginBottom: 8 },
  sectionHeader: { padding: '4px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#555', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em' },
  addBtn: { background: 'transparent', border: 'none', color: '#555', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0 },
  newChannelForm: { padding: '4px 10px 8px', display: 'flex', flexDirection: 'column', gap: 4 },
  input: { background: '#1e1e30', border: '1px solid #333', borderRadius: 6, padding: '5px 8px', color: '#fff', fontSize: 12, outline: 'none' },
  checkRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', cursor: 'pointer' },
  createBtn: { background: '#6366f1', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 11, padding: '6px 8px', marginTop: 4 },
  channelItem: { padding: '6px 12px', cursor: 'pointer', borderRadius: 6, margin: '1px 6px', display: 'flex', alignItems: 'center', gap: 8 },
  channelActive: { background: '#6366f120' },
  infoBtn: { background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12, opacity: 0.5, padding: '0 2px' },
  badge: { background: '#6366f1', color: '#fff', borderRadius: 10, padding: '1px 6px', fontSize: 11, fontWeight: 700 },
  memberPanel: { background: '#0f0f1a', margin: '0 6px 4px', borderRadius: 6, padding: '8px 10px' },
  memberRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' },
  addMemberBtn: { background: 'transparent', border: '1px dashed #333', borderRadius: 4, color: '#666', cursor: 'pointer', fontSize: 11, padding: '3px 8px', marginTop: 6, width: '100%' },
  leaveBtn: { background: 'transparent', border: '1px solid #3f1515', borderRadius: 4, color: '#ef4444', cursor: 'pointer', fontSize: 11, padding: '3px 8px', marginTop: 4, width: '100%' },
  userItem: { padding: '6px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, borderRadius: 6, margin: '1px 6px' },
  avatar: { width: 30, height: 30, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 13, fontWeight: 700, flexShrink: 0 },
  footer: { padding: '10px 12px', borderTop: '1px solid #1e1e2e', display: 'flex', alignItems: 'center', gap: 8 },
  footerBtn: { background: 'transparent', border: 'none', color: '#666', cursor: 'pointer', fontSize: 16, padding: '4px', borderRadius: 6 },
}
