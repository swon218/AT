import { useEffect, useState } from 'react'
import { getBrokerAccountSummary } from '../services/kiwoomAccountApi'

function useBrokerAssets(broker, { userId, selected, integrationStatus, integrationVersion, refreshVersion, accountIds }) {
  const enabled = Boolean(userId && selected.includes(broker) && integrationStatus[`${broker}Configured`])
  const owner = JSON.stringify([userId, integrationVersion])
  const accountId = accountIds[broker] || ''
  const scope = JSON.stringify([owner, enabled, accountId, refreshVersion])
  const [result, setResult] = useState(null)
  const [accountOptions, setAccountOptions] = useState(null)

  useEffect(() => {
    if (!enabled) return undefined
    let active = true
    setResult({ scope, status: 'loading' })
    getBrokerAccountSummary(broker, '', accountId)
      .then(summary => {
        if (!active) return
        setAccountOptions({ owner, accounts: summary.accounts || [] })
        setResult({ scope, status: summary.accountRequired ? 'accountRequired' : 'ready', summary })
      })
      .catch(error => {
        if (active) setResult({ scope, status: 'error', error: error.message })
      })
    return () => { active = false }
  }, [broker, enabled, owner, scope, accountId])

  if (!enabled) return { status: userId ? 'unconfigured' : 'guest', accounts: [] }
  const current = result?.scope === scope ? result : { status: 'loading' }
  return { ...current, accounts: accountOptions?.owner === owner ? accountOptions.accounts : [] }
}

export default function useAssetAccounts(options) {
  const kiwoom = useBrokerAssets('kiwoom', options)
  const toss = useBrokerAssets('toss', options)
  const nh = useBrokerAssets('nh', options)
  const kb = useBrokerAssets('kb', options)
  return { kiwoom, toss, nh, kb }
}
