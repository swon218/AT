import { config } from './config.js'
import { kakaoRpcStore, verifyLink } from './kakaoConnection.js'
import { createKakaoProvider } from './kakaoProvider.js'

export function createAlertAccess({ db = kakaoRpcStore(), provider = createKakaoProvider(config) } = {}) {
  return async function access(userId, force = false) {
    if (!db) return { status: 'unavailable' }
    const actor = { user_id: userId }
    const read = () => db('read', actor)
    await verifyLink(actor, read, db, provider, force)
    const link = (await read()).find(row => row.status !== 'unlinking')
    if (!link || link.status === 'reconnect' || (link.status === 'connected' && !link.scopes.includes('talk_message'))) {
      return { status: 'kakao_required' }
    }
    if (link.status !== 'connected' || Date.parse(link.access_until) <= Date.now() + 10_000
      || Date.parse(link.verified_at) <= Date.now() - 60_000 || (link.operation && Date.parse(link.lease_until) > Date.now())) {
      return { status: 'unavailable' }
    }
    return { status: 'ready', link }
  }
}
