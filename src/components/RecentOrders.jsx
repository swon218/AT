import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import useRecentOrders from '../hooks/useRecentOrders'
import { getRecentOrders } from '../services/recentOrdersApi'
import { BROKERS, getBroker } from '../utils/brokers'
import { orderStatusLabels } from '../utils/recentOrders'
import { toggleAssetBroker } from '../utils/assetSummary'

const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '—'
const money = value => value == null ? '—' : `${number(value)}원`
const time = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value)) : '—'

function OrderDetails({ order, accountRefs, scope }) {
  const [result, setResult] = useState(null)
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setResult(null)
    getRecentOrders({ broker: order.broker, id: order.id, accountRefs, signal: controller.signal })
      .then(data => { if (active) setResult({ scope, item: data.item }) })
      .catch(error => { if (active && !controller.signal.aborted) setResult({ scope, error: error.message }) })
    return () => { active = false; controller.abort() }
  }, [order.id, scope])
  const current = result?.scope === scope ? result : null
  if (!current) return <div className="recent-order-detail" role="status">상세 내역 조회 중…</div>
  if (current.error) return <div className="recent-order-detail" role="status">상세 내역을 조회하지 못했습니다. 다시 펼쳐 조회해 주세요.</div>
  const item = current.item
  return <div className="recent-order-detail">
    <p>{getBroker(item.broker).name} · {item.accountLabel} · 주문가 {item.marketOrder ? '시장가' : money(item.orderPrice)}</p>
    {item.executions?.length ? <ul aria-label="개별 체결 내역">{item.executions.map(fill => <li key={fill.id}><span>{time(fill.at)} KST</span><span>{number(fill.quantity)}주</span><span>{money(fill.price)}</span></li>)}</ul> : <p>{item.filledQuantity === 0 ? '체결 내역이 없습니다.' : item.broker === 'kiwoom' ? '개별 체결 내역을 확인할 수 없습니다.' : '이 조회 API는 개별 체결 시각·수량·가격 목록을 제공하지 않습니다.'}{item.lastFilledAt && ` 최종 체결 ${time(item.lastFilledAt)} KST`}</p>}
  </div>
}

export default function RecentOrders({ currentUser, integrationStatus, integrationVersion, selected, onSelectedChange, onOpenSettings, onLogin }) {
  const [selection, setSelection] = useState(null)
  const accountRefs = selection?.owner === currentUser?.id && selection?.version === integrationVersion ? selection.refs : {}
  const state = useRecentOrders({ userId: currentUser?.id, integrationStatus, integrationVersion, accountRefs, selected })
  const [expanded, setExpanded] = useState(null)
  const data = currentUser && selected.length ? state.data : null
  const missing = data?.brokers.filter(broker => broker.status === 'unconfigured') || []
  const failures = data?.brokers.filter(broker => broker.status === 'error') || []
  const accountRequired = data?.brokers.filter(broker => broker.status === 'accountRequired') || []
  const emptySuccess = selected.length > 0 && data?.brokers.length === selected.length && data.brokers.every(broker => broker.status === 'ready') && !data.items.length

  return <article className="panel dashboard-recent-orders">
    <div className="panel-head recent-orders-head"><div><h2>최근 주문 · 체결 내역</h2></div><button type="button" className="dashboard-news-more recent-orders-more" disabled title="주문·체결 내역 탭 준비 중" aria-label="최근 주문·체결 내역 더보기 (준비 중)">더보기</button></div>
    <div className="holdings-broker-tabs recent-orders-brokers" role="group" aria-label="최근 주문 증권사 선택">{BROKERS.map(broker => <button type="button" key={broker.id} aria-pressed={selected.includes(broker.id)} className={selected.includes(broker.id) ? `active ${broker.id}` : ''} onClick={() => onSelectedChange(value => toggleAssetBroker(value, broker.id, { allowEmpty: true }))}>{broker.shortName}</button>)}</div>
    {!selected.length ? <div className="data-message" role="status">증권사를 선택해주세요</div>
      : !currentUser ? <div className="data-message">로그인 후 최근 주문·체결 내역을 볼 수 있습니다.<button type="button" className="recent-orders-link" onClick={onLogin}>로그인</button></div>
      : <>
        <div className="recent-orders-meta">최근 5거래일 · 최근 5건 · 최신 거래가 아래에 표시됩니다.{data?.range && <span>{data.range.days.at(-1)} ~ {data.range.days[0]} · KST</span>}</div>
        {missing.length > 0 && <p className="recent-orders-warning" role="status">{missing.map(broker => getBroker(broker.broker).name).join(' · ')} API 미등록 · 연결된 선택 증권사의 내역을 표시합니다. <button type="button" className="recent-orders-link" onClick={onOpenSettings}>개인 설정</button></p>}
        {data && <div className="recent-order-accounts">{data.brokers.map(broker => broker.accounts?.length > 1 ? <label key={broker.broker}>{getBroker(broker.broker).shortName} 조회 계좌<select aria-label={`${getBroker(broker.broker).name} 주문내역 조회 계좌`} value={accountRefs[broker.broker] || broker.selectedAccountRef || ''} onChange={event => setSelection({ owner: currentUser.id, version: integrationVersion, refs: { ...accountRefs, [broker.broker]: event.target.value } })}><option value="" disabled>계좌 선택</option>{broker.accounts.map(account => <option value={account.id} key={account.id}>{account.label}</option>)}</select></label> : broker.selectedAccountRef ? <small key={broker.broker}>{getBroker(broker.broker).shortName} · {broker.accounts?.[0]?.label}</small> : null)}</div>}
        {failures.length > 0 && <p className="recent-orders-warning" role="status">{failures.map(broker => getBroker(broker.broker).name).join(' · ')} 조회 실패 · 성공한 증권사 내역만 표시합니다.</p>}
        {accountRequired.length > 0 && <p className="recent-orders-warning" role="status">{accountRequired.map(broker => getBroker(broker.broker).name).join(' · ')} 조회 계좌를 선택해 주세요.</p>}
        {data?.orderingIncomplete && <p className="recent-orders-warning">주문 시각 미제공 내역은 같은 날짜의 시각 확인 내역 앞에 표시합니다. 해당 날짜 내 정확한 시간순서는 확인할 수 없습니다.</p>}
        {state.loading ? <div className="data-message" role="status">주문·체결 내역을 조회하고 있습니다.</div>
          : state.error ? <div className="data-message" role="status">{state.error.message}</div>
          : emptySuccess ? <div className="data-message">최근 주문 없음</div>
          : !data?.items.length ? <div className="data-message">조회가 완료되지 않은 증권사가 있습니다.</div>
          : <div className="dashboard-orders-scroll"><table className="dashboard-orders-table recent-orders-table" aria-label="최근 주문 및 체결 내역"><thead><tr><th scope="col">주문 날짜·시각</th><th scope="col">증권사</th><th scope="col">종목·매매</th><th scope="col">체결/주문수량</th><th scope="col">평균체결가</th><th scope="col">상태</th></tr></thead><tbody>{data.items.map(order => {
            const open = expanded?.scope === state.scope && expanded.id === order.id
            return <OrderRow key={order.id} order={order} open={open} onToggle={() => setExpanded(open ? null : { scope: state.scope, id: order.id })} accountRefs={accountRefs} scope={state.scope}/>
          })}</tbody></table></div>}
      </>}
  </article>
}

function OrderRow({ order, open, onToggle, accountRefs, scope }) {
  return <>
    <tr className="recent-order-row"><td><button type="button" aria-label={`${getBroker(order.broker).shortName} ${order.name || order.symbol} 주문 상세`} aria-expanded={open} onClick={onToggle}><ChevronDown size={12} className={open ? 'is-open' : ''}/><span>{order.date.slice(5)}<small>{time(order.orderedAt)}</small></span></button></td><td>{getBroker(order.broker).shortName}</td><td><strong>{order.name || order.symbol}</strong><small>{order.side === 'buy' ? '매수' : order.side === 'sell' ? '매도' : '—'} · {order.symbol}</small></td><td>{number(order.filledQuantity)}/{number(order.quantity)}주</td><td>{money(order.averageFilledPrice)}</td><td><span className={`recent-order-state ${order.status}`}>{orderStatusLabels[order.status] || '상태 확인 필요'}</span></td></tr>
    {open && <tr><td colSpan={6}><OrderDetails order={order} accountRefs={accountRefs} scope={scope}/></td></tr>}
  </>
}
