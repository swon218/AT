import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import useRecentOrders from '../hooks/useRecentOrders'
import { getRecentOrders } from '../services/recentOrdersApi'
import { BROKERS, getBroker } from '../utils/brokers'
import { orderStatusLabels, recentOrdersEmptyMessage } from '../utils/recentOrders'
import { toggleAssetBroker } from '../utils/assetSummary'
import { koreanOrderDay, MAX_ORDER_PERIOD_DAYS, orderPeriodError, recentOrderPeriod } from '../utils/orderPeriod'

const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '—'
const money = value => value == null ? '—' : `${number(value)}원`
const time = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value)) : '—'

function OrderDetails({ order, period, userId, scope }) {
  const [result, setResult] = useState(null)
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setResult(null)
    getRecentOrders({ broker: order.broker, id: order.id, accountRefs: { [order.broker]: order.accountRef },
      userId, period, day: order.date, signal: controller.signal })
      .then(data => { if (active) setResult({ scope, item: data.item }) })
      .catch(error => { if (active && !controller.signal.aborted) setResult({ scope, error: error.message }) })
    return () => { active = false; controller.abort() }
  }, [order.id, scope])
  const current = result?.scope === scope ? result : null
  if (!current) return <div className="recent-order-detail" role="status">상세 내역 조회 중…</div>
  if (current.error) return <div className="recent-order-detail" role="status">{current.error} 다시 펼쳐 조회해 주세요.</div>
  const item = current.item
  return <div className="recent-order-detail">
    <p>{getBroker(item.broker).name} · {item.accountLabel} · 주문가 {item.marketOrder ? '시장가' : money(item.orderPrice)}</p>
    {item.executions?.length ? <ul aria-label="개별 체결 내역">{item.executions.map(fill => <li key={fill.id}><span>{fill.at ? `${time(fill.at)} KST` : '—'}</span><span>{number(fill.quantity)}주</span><span>{money(fill.price)}</span></li>)}</ul> : <p>{item.filledQuantity === 0 ? '체결 내역이 없습니다.' : item.broker === 'kiwoom' ? '개별 체결 내역을 확인할 수 없습니다.' : '이 조회 API는 개별 체결 시각·수량·가격 목록을 제공하지 않습니다.'}{item.lastFilledAt && ` 최종 체결 ${time(item.lastFilledAt)} KST`}</p>}
  </div>
}

function PeriodInput({ label, name, value, max, onChange, invalid }) {
  return <label>{label}<input type="date" name={name} value={value} max={max} required aria-invalid={invalid || undefined}
    onInput={event => onChange(event.currentTarget.value)} onClick={event => {
      try { event.currentTarget.showPicker?.() } catch { /* The native date control remains available. */ }
    }}/></label>
}

export default function RecentOrders({ currentUser, integrationStatus, integrationVersion, selected, onSelectedChange,
  history = false, initialAccountRefs, reveal = false, onOpenHistory }) {
  const userId = currentUser?.id
  const [localBrokers, setLocalBrokers] = useState(() => selected ?? BROKERS.map(({ id }) => id))
  const brokers = onSelectedChange ? selected : localBrokers
  const chooseBrokers = onSelectedChange || setLocalBrokers
  const [selection, setSelection] = useState(null)
  const accountRefs = selection?.owner === userId && selection?.version === integrationVersion ? selection.refs : initialAccountRefs ?? {}
  const [applied, setApplied] = useState(() => ({ period: recentOrderPeriod(), revision: 0 }))
  const [draft, setDraft] = useState(applied.period)
  const [periodError, setPeriodError] = useState('')
  const period = history ? applied.period : recentOrderPeriod()
  const [clockDay, setClockDay] = useState(koreanOrderDay)
  const state = useRecentOrders({ userId, integrationStatus, integrationVersion, accountRefs, selected: brokers, period, revision: applied.revision })
  const [expanded, setExpanded] = useState(null)
  const heading = useRef(null), viewport = useRef(null), positionedScope = useRef(null), anchor = useRef(null)
  const headingId = useId()
  const pages = state.pages || []
  const first = pages[0], latestBrokers = first?.brokers || []
  const retryPages = pages.filter(page => page.brokers.some(result => ['error', 'partial'].includes(result.status)))
  const emptyMessage = first && !state.items.length
    ? recentOrdersEmptyMessage({ brokers: pages.flatMap(page => page.brokers), more: Boolean(state.nextBefore) })
    : null
  const accountChoices = brokers.map(id => state.accountChoices[id]).filter(broker => broker?.accounts?.length > 1)
  const hasConfigured = latestBrokers.some(result => result.status !== 'unconfigured' && result.status !== 'accountRequired')
  const title = history ? '거래 내역' : '최근 주문 · 체결 내역'
  useEffect(() => {
    const refresh = () => setClockDay(koreanOrderDay())
    const timer = setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [])
  useEffect(() => {
    if (!reveal) return undefined
    const frame = requestAnimationFrame(() => {
      heading.current?.focus({ preventScroll: true })
      heading.current?.scrollIntoView({ block: 'start' })
    })
    return () => cancelAnimationFrame(frame)
  }, [reveal])
  useLayoutEffect(() => {
    const box = viewport.current
    if (!box) return
    if (positionedScope.current !== state.scope) {
      positionedScope.current = state.scope
      anchor.current = null
      box.scrollTop = box.scrollHeight
    } else if (anchor.current?.scope === state.scope && pages.length > anchor.current.pages) {
      box.scrollTop = anchor.current.top + box.scrollHeight - anchor.current.height
      anchor.current = null
    }
  }, [state.scope, state.items, pages.length])

  function query(next) {
    const error = orderPeriodError(next)
    setPeriodError(error)
    if (!error) setApplied(previous => ({ period: next, revision: previous.revision + 1 }))
  }

  function loadOlder() {
    if (!state.nextBefore || state.pending || !hasConfigured) return
    const box = viewport.current
    if (box) anchor.current = { scope: state.scope, pages: pages.length, top: box.scrollTop, height: box.scrollHeight }
    state.loadOlder()
  }

  function more() {
    const refs = Object.fromEntries(brokers.flatMap(id => {
      const ref = latestBrokers.find(result => result.broker === id)?.selectedAccountRef || accountRefs[id]
      return ref ? [[id, ref]] : []
    }))
    onOpenHistory({ selected: brokers, accountRefs: refs })
  }

  return <article className={`panel dashboard-recent-orders${history ? ' preview-wide order-history-panel' : ''}`} aria-labelledby={headingId}>
    <div className="panel-head recent-orders-head">
      <h2 id={headingId} ref={heading} tabIndex={history ? -1 : undefined}>{title}</h2>
      <div className="holdings-broker-tabs recent-orders-brokers" role="group" aria-label={`${title} 증권사 선택`}>{BROKERS.map(broker => <button type="button" key={broker.id} aria-pressed={brokers.includes(broker.id)} className={brokers.includes(broker.id) ? 'active' : ''} onClick={() => chooseBrokers(value => toggleAssetBroker(value, broker.id, { allowEmpty: true }))}>{broker.shortName}</button>)}</div>
      {!history && <button type="button" className="dashboard-news-more recent-orders-more" onClick={more} aria-label="최근 주문·체결 내역 더보기">더보기</button>}
    </div>
    {history && currentUser && <form className="order-history-period" noValidate onSubmit={event => { event.preventDefault(); query(draft) }}>
      <PeriodInput label="시작일" name="from" max={clockDay} value={draft.start} invalid={Boolean(periodError)} onChange={start => { setDraft({ ...draft, start }); setPeriodError('') }}/>
      <PeriodInput label="종료일" name="to" max={clockDay} value={draft.end} invalid={Boolean(periodError)} onChange={end => { setDraft({ ...draft, end }); setPeriodError('') }}/>
      <button type="submit">조회</button>
      <button type="button" onClick={() => { const next = recentOrderPeriod(); setDraft(next); query(next) }}>최근 일주일</button>
      <small>최대 {MAX_ORDER_PERIOD_DAYS}일 · 시작일과 종료일 포함 · 증권사별 제공 범위가 다를 수 있습니다.</small>
      {periodError && <p role="alert">{periodError}</p>}
    </form>}
    <div className="recent-orders-meta"><span>{history ? '조회 기간' : '최근 일주일'} {period.start} ~ {period.end} · KST</span><span>최신 거래가 아래에 표시됩니다.</span></div>
    {!brokers.length ? <div className="data-message" role="status">증권사를 선택해 주세요.</div>
      : !currentUser ? <div className="data-message">로그인 후 주문·체결 내역을 볼 수 있습니다.</div>
      : <>
        {accountChoices.length > 0 && <div className="recent-order-accounts">{accountChoices.map(broker => <label key={broker.broker}>{getBroker(broker.broker).shortName} 조회 계좌<select aria-label={`${getBroker(broker.broker).name} 주문내역 조회 계좌`} value={broker.accounts.some(account => account.id === accountRefs[broker.broker]) ? accountRefs[broker.broker] : broker.selectedAccountRef || ''} onChange={event => setSelection({ owner: userId, version: integrationVersion, refs: { ...accountRefs, [broker.broker]: event.target.value } })}><option value="" disabled>계좌 선택</option>{broker.accounts.map(account => <option value={account.id} key={account.id}>{account.label}</option>)}</select></label>)}</div>}
        {latestBrokers.some(result => result.status === 'accountRequired') && <p className="recent-orders-warning">조회 계좌 선택 필요 · {latestBrokers.filter(result => result.status === 'accountRequired').map(result => getBroker(result.broker).shortName).join(', ')}</p>}
        {state.items.some(item => !item.orderedAt) && <p className="recent-orders-warning">주문 시각 미제공 내역은 같은 날짜의 시각 확인 내역 앞에 표시합니다. 해당 날짜 내 정확한 시간순서는 확인할 수 없습니다.</p>}
        {retryPages.map(page => {
          const retryLabel = `다시 조회 (${page.window.start} ~ ${page.window.end})`
          return <div className="recent-orders-load" key={page.window.start}>
            <button type="button" disabled={state.pending} aria-label={retryLabel} onClick={() => state.retry(page.before)}>
              {retryPages.length === 1 ? '다시 조회' : retryLabel}
            </button>
          </div>
        })}
        {state.error && <div className="recent-orders-load" role="status">거래 내역을 불러오지 못했습니다. <button type="button" onClick={() => state.retry(state.before)}>다시 조회</button></div>}
        {state.pending && pages.length > 0 && <p className="recent-orders-load" role="status">주문·체결 내역을 추가 조회하고 있습니다…</p>}
        {state.nextBefore && hasConfigured && <div className="recent-orders-load"><button type="button" disabled={state.pending} onClick={loadOlder}>이전 날짜 더 불러오기</button> <span>{pages.at(-1).window.start}부터 표시 중</span></div>}
        {state.loading ? <div className="data-message" role="status">주문·체결 내역을 조회하고 있습니다.</div>
          : !state.items.length ? (emptyMessage && <div className="data-message" role="status">{emptyMessage}</div>)
          : <div className="dashboard-orders-scroll" ref={viewport} tabIndex={0} role="region" aria-label={`${title} 목록`} onScroll={event => {
            const box = event.currentTarget
            if (!state.error && box.scrollTop <= 12 && box.scrollHeight > box.clientHeight + 12) loadOlder()
          }}><table className="dashboard-orders-table recent-orders-table" aria-label="국내주식 주문 및 체결 내역"><thead><tr><th scope="col">주문 날짜·시각</th><th scope="col">증권사</th><th scope="col">종목·매매</th><th scope="col">체결/주문수량</th><th scope="col">평균체결가</th><th scope="col">상태</th></tr></thead><tbody>{state.items.map(order => {
            const open = expanded?.scope === state.scope && expanded.id === order.id
            return <OrderRow key={order.id} order={order} open={open} onToggle={() => setExpanded(open ? null : { scope: state.scope, id: order.id })} period={period} userId={userId} scope={state.scope}/>
          })}</tbody></table></div>}
      </>}
  </article>
}

function OrderRow({ order, open, onToggle, period, userId, scope }) {
  return <>
    <tr className="recent-order-row"><td><button type="button" aria-label={`${getBroker(order.broker).shortName} ${order.name || order.symbol} 주문 상세`} aria-expanded={open} onClick={onToggle}><ChevronDown size={12} className={open ? 'is-open' : ''}/><span>{order.date}<small>{time(order.orderedAt)}</small></span></button></td><td>{getBroker(order.broker).shortName}</td><td><strong>{order.name || order.symbol}</strong><small>{order.side === 'buy' ? '매수' : order.side === 'sell' ? '매도' : '—'} · {order.symbol}</small></td><td>{number(order.filledQuantity)}/{number(order.quantity)}주</td><td>{money(order.averageFilledPrice)}</td><td><span className={`recent-order-state ${order.status}`}>{orderStatusLabels[order.status] || '상태 확인 필요'}</span></td></tr>
    {open && <tr><td colSpan={6}><OrderDetails order={order} period={period} userId={userId} scope={scope}/></td></tr>}
  </>
}
