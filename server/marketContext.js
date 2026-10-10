import { createHash } from 'node:crypto'
import { getAuthenticatedCredentials } from './accountSettings.js'
import { requestKiwoom, requestKiwoomWithCredentials, getKiwoomRealtimeAuth } from './kiwoomClient.js'

// Resolve on the server; a browser cannot choose the operator's credentials.
export function createMarketRequestContext({ authenticate = getAuthenticatedCredentials, operator = requestKiwoom, personal = requestKiwoomWithCredentials } = {}) {
  return async (request) => {
    const authorization = request.headers.authorization || ''
    if (!authorization) return { requester: operator, cacheScope: 'operator', getRealtimeAuth: () => getKiwoomRealtimeAuth() }
    const { user, credentials, status } = await authenticate(request)
    if (!status.kiwoomConfigured || !credentials.kiwoomAppKey || !credentials.kiwoomSecretKey) {
      return { requester: operator, cacheScope: 'operator', getRealtimeAuth: () => getKiwoomRealtimeAuth() }
    }
    const { kiwoomAppKey: appKey, kiwoomSecretKey: secretKey } = credentials
    const fingerprint = createHash('sha256').update(`${appKey}\0${secretKey}`).digest('hex')
    return {
      cacheScope: `user:${user.id}:${fingerprint}`,
      requester: (definition) => personal({ ...definition, appKey, secretKey }),
      getRealtimeAuth: () => getKiwoomRealtimeAuth({ appKey, secretKey }),
    }
  }
}

export const marketRequestContext = createMarketRequestContext()
