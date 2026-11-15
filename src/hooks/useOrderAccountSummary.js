import { useEffect, useState } from 'react'
import { getBrokerAccountSummary } from '../services/kiwoomAccountApi'

// One read feeds both the order form and its optional personal price line.
export default function useOrderAccountSummary({ active, userId, broker, configured, credentialVersion, accountId = '', symbol = '', refreshVersion = 0 }) {
  const [result, setResult] = useState(null)
  const [accountOptions, setAccountOptions] = useState(null)
  const owner = JSON.stringify([userId, broker, credentialVersion])
  const scope = JSON.stringify([owner, accountId, symbol, refreshVersion])
  const enabled = Boolean(active && userId && configured)

  useEffect(() => {
    if (!enabled) { setResult(null); return undefined }
    let live = true
    const controller = new AbortController()
    setResult({ scope, status: 'loading' })
    getBrokerAccountSummary(broker, symbol, broker === 'nh' ? accountId : '', { signal: controller.signal, userId })
      .then(summary => {
        if (!live || controller.signal.aborted) return
        if (summary?.broker !== broker || !Array.isArray(summary.holdings)) throw new Error('증권사 보유정보 응답을 확인할 수 없습니다.')
        setAccountOptions({ owner, accounts: summary.accounts || [], selectedAccountId: summary.selectedAccountId || '' })
        setResult({ scope, status: 'ready', summary, receivedAt: Date.now() })
      })
      .catch(error => {
        if (live && !controller.signal.aborted) setResult({ scope, status: 'error', error: error.message })
      })
    return () => { live = false; controller.abort() }
  }, [enabled, scope, broker, symbol, accountId, userId, owner])

  const current = enabled && result?.scope === scope ? result : { status: enabled ? 'loading' : 'idle' }
  const options = accountOptions?.owner === owner ? accountOptions : null
  return {
    ...current,
    accounts: options?.accounts || [],
    // Preserve the last verified opaque account ref while revalidating the same scope.
    accountScope: accountId || options?.selectedAccountId || '',
  }
}
