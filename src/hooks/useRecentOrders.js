import { useEffect, useMemo, useRef, useState } from 'react'
import { getRecentOrders } from '../services/recentOrdersApi'
import { mergeOrderWindow, orderWindowItems, recentOrderScope } from '../utils/recentOrders'

const failed = result => result.status === 'error' || result.status === 'partial'

export default function useRecentOrders({ userId, integrationStatus, integrationVersion, accountRefs, selected, period, revision }) {
  const owner = recentOrderScope(userId, integrationStatus, integrationVersion)
  const scope = recentOrderScope(userId, integrationStatus, integrationVersion, accountRefs, selected, { ...period, revision })
  const enabled = Boolean(userId && selected.length)
  const [state, setState] = useState(null)
  const [choices, setChoices] = useState(null)
  const active = useRef(null)
  const current = enabled && state?.scope === scope ? state : null
  const pages = current?.pages
  const items = useMemo(() => pages ? orderWindowItems(pages) : [], [pages])

  async function load(context, before = null, retry = false) {
    if (active.current !== context || context.pending) return
    const existing = context.pages.find(page => page.before === before)
    const brokers = retry && existing ? existing.brokers.filter(failed).map(result => result.broker) : context.selected
    if (!brokers.length) return
    context.pending = true
    setState({ scope: context.scope, pages: context.pages, pending: true, before })
    try {
      const page = await getRecentOrders({ ...context.request, selected: brokers, before, signal: context.controller.signal })
      // Scope ownership still matters when a transport returns after cancellation.
      if (active.current !== context) return
      setChoices(previous => ({
        owner: context.owner, byBroker: {
          ...(previous?.owner === context.owner ? previous.byBroker : {}),
          ...Object.fromEntries(page.brokers.filter(result => result.accounts?.length || result.status === 'unconfigured')
            .map(result => [result.broker, result])),
        },
      }))
      const updated = { ...mergeOrderWindow(existing, page, brokers), before }
      context.pages = existing ? context.pages.map(value => value === existing ? updated : value) : [...context.pages, updated]
      setState({ scope: context.scope, pages: context.pages })
    } catch (error) {
      if (active.current === context) setState({ scope: context.scope, pages: context.pages, error, before })
    } finally {
      context.pending = false
    }
  }

  useEffect(() => {
    if (!enabled) return undefined
    const context = { scope, owner, selected, pages: [], controller: new AbortController(), request: { userId, accountRefs, period } }
    active.current = context
    const timer = setTimeout(() => load(context), 350)
    return () => { clearTimeout(timer); active.current = null; context.controller.abort() }
  }, [enabled, scope])

  const nextBefore = pages?.at(-1)?.window.nextBefore
  const run = (before, retry) => {
    if (active.current?.scope === scope) void load(active.current, before, retry)
  }
  return {
    scope, pages, items, nextBefore, accountChoices: choices?.owner === owner ? choices.byBroker : {},
    loading: enabled && !pages?.length && !current?.error, pending: current?.pending, error: current?.error, before: current?.before,
    loadOlder: () => { if (nextBefore) run(nextBefore, false) },
    retry: before => run(before, true),
  }
}
