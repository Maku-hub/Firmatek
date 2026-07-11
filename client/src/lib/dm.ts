// Direct-message channels are named "dm:<userA>:<userB>". These helpers extract
// the other participant, centralising parsing that was previously duplicated
// across ChatWindow, Sidebar and SearchPanel.

/** Returns the other participant's user ID for a DM channel name, or null. */
export function dmPartnerId(channelName: string, currentUserId: string): string | null {
  const parts = channelName.split(':')
  if (parts.length === 3 && parts[0] === 'dm') {
    return parts[1] === currentUserId ? parts[2] : parts[1]
  }
  return null
}
