import { createHash } from 'node:crypto'
import { getAuthenticatedCredentials } from './accountSettings.js'
import { requestKiwoom, requestKiwoomWithCredentials, getKiwoomRealtimeAuth } from './kiwoomClient.js'

// Resolve on the server; a browser cannot choose the operator's credentials.
export function createMarketRequestContext({ authenticate = getAuthenticatedCredentials, operator = requestKiwoom, personal = requestKiwoomWithCredentials, realtime = getKiwoomRealtimeAuth } = {}) {
  return async (request) => {
    const authorization = request.headers.authorization || ''
    if (!authorization) return { requester: operator, cacheScope: 'operator', getRealtimeAuth: () => realtime() }
    const { user, credentials, status } = await authenticate(request)
    if (!status.kiwoomConfigured || !credentials.kiwoomAppKey || !credentials.kiwoomSecretKey) {
      return { requester: operator, cacheScope: 'operator', getRealtimeAuth: () => realtime() }
    }
    const { kiwoomAppKey: appKey, kiwoomSecretKey: secretKey } = credentials
    const ownerId = user.id
    const fingerprint = createHash('sha256').update(`${appKey}\0${secretKey}`).digest('hex')
    return {
      cacheScope: `user:${user.id}:${fingerprint}`,
      requester: (definition) => personal({ ...definition, appKey, secretKey }),
      getRealtimeAuth: async () => {
        // A session hub can reconnect long after this HTTP request completed.
        // Re-read the encrypted row before issuing/using a token, including when
        // another API process deleted the key or this context arrived late.
        const latest = await authenticate({ headers: { authorization } })
        const nextKey = latest.credentials?.kiwoomAppKey, nextSecret = latest.credentials?.kiwoomSecretKey
        if (latest.user?.id !== ownerId || !latest.status?.kiwoomConfigured || !nextKey || !nextSecret ||
          createHash('sha256').update(`${nextKey}\0${nextSecret}`).digest('hex') !== fingerprint) {
          throw Object.assign(new Error('개인 API 정보가 변경되었습니다. 상태를 다시 확인해 주세요.'), { statusCode: 403 })
        }
        return realtime({ appKey: nextKey, secretKey: nextSecret })
      },
    }
  }
}

export const marketRequestContext = createMarketRequestContext()
