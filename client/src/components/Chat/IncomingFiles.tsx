import { useEffect, useState } from 'react'
import { webrtcService, type IncomingOffer } from '../../services/webrtc'
import { useStore } from '../../store'
import { t } from '../../i18n'
import { formatSize } from '../../lib/format'
import { createFileSink } from '../../lib/fileSink'
import ConfirmDialog from '../UI/ConfirmDialog'

// Asks the user about incoming peer-to-peer files, one offer at a time. It is
// mounted at the app root so an offer is seen even when no chat is open.
export default function IncomingFiles() {
  const [queue, setQueue] = useState<IncomingOffer[]>([])

  useEffect(() => {
    webrtcService.setIncomingCallback((offer) => setQueue((q) => [...q, offer]))
    webrtcService.setOfferWithdrawnCallback((id) => setQueue((q) => q.filter((o) => o.transferID !== id)))
  }, [])

  const offer = queue[0]
  if (!offer) return null

  const next = () => setQueue((q) => q.slice(1))

  const accept = async () => {
    next()
    try {
      // In the desktop app the file goes straight to the chosen location,
      // so its size is not limited by available memory.
      const sink = await createFileSink(offer.filename)
      if (!sink) {
        webrtcService.declineIncoming(offer)
        return
      }
      const blob = await webrtcService.acceptIncoming(offer, sink)
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = offer.filename
      a.click()
      // Revoking straight after click() can abort the download in the webview.
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (err) {
      console.error('[p2p] receive failed:', err)
      // e.g. the chosen location was not writable: tell the sender right away
      // instead of letting them wait for a timeout.
      if (webrtcService.hasPendingOffer(offer.transferID)) webrtcService.declineIncoming(offer)
    }
  }

  const decline = () => {
    next()
    webrtcService.declineIncoming(offer)
  }

  const senderName = useStore.getState().users[offer.fromUserID]?.display_name ?? t('chat.unknown')

  return (
    <ConfirmDialog
      key={offer.transferID}
      title={t('chat.incomingFile')}
      message={t('chat.wantsToSend', { name: senderName, file: offer.filename, size: formatSize(offer.fileSize) })}
      confirmLabel={t('chat.accept')}
      cancelLabel={t('chat.decline')}
      onConfirm={accept}
      onCancel={decline}
    />
  )
}
