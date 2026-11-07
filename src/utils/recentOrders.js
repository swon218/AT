import { BROKERS } from './brokers.js'

export const orderStatusLabels = { filled: '체결 완료', partiallyFilled: '부분체결', residualCancelled: '잔량취소', cancelled: '전량 취소', rejected: '거절', pending: '접수·미체결', replaced: '정정됨', unknown: '상태 확인 필요' }
export const recentOrderScope = (userId, status, version, accountRefs, selected, period) => JSON.stringify([userId, BROKERS.map(({ id }) => Boolean(status?.[`${id}Configured`])), version, accountRefs, selected, period])

export const orderWindowItems = pages => [...new Map([...pages].reverse().flatMap(page => page.items).map(item => [item.id, item])).values()]

// A missing provider time sorts before known times on that day, without inventing a time.
export const compareOrderHistory = (a, b) => a.date.localeCompare(b.date) ||
  (a.orderedAt ? Date.parse(a.orderedAt) : -Infinity) - (b.orderedAt ? Date.parse(b.orderedAt) : -Infinity) || b.id.localeCompare(a.id)

export function mergeOrderWindow(previous, next, retried) {
  if (!previous) return next
  const results = new Map(next.brokers.map(result => [result.broker, result]))
  // Keep earlier verified dates when a retry itself returns a partial result.
  const retained = previous.items.filter(item => {
    const result = results.get(item.broker)
    return !retried.includes(item.broker) || (['error', 'partial'].includes(result?.status) && !result.completedDays?.includes(item.date))
  })
  const items = [...new Map([...retained, ...next.items].map(item => [item.id, item])).values()]
  items.sort(compareOrderHistory)
  const brokers = previous.brokers.map(result => {
    const update = results.get(result.broker)
    if (!update) return result
    if (!['error', 'partial'].includes(update.status) || !result.completedDays?.length) return update
    const completedDays = [...new Set([...result.completedDays, ...(update.completedDays || [])])].sort().reverse()
    return { ...update, status: 'partial', completedDays }
  })
  return { ...next, items, brokers }
}

export function recentOrdersEmptyMessage(data) {
  const brokers = data?.brokers?.filter(broker => broker.status !== 'unconfigured') || []
  if (!brokers.length) return '조회 가능한 증권사가 없습니다.'
  if (brokers.some(broker => ['partial', 'error'].includes(broker.status))) return null
  if (brokers.some(broker => broker.status === 'accountRequired')) return '조회 계좌를 선택해주세요.'
  if (!brokers.every(broker => broker.status === 'ready')) return '거래 내역을 불러오지 못했습니다.'
  return data.more ? '불러온 날짜에 거래 내역이 없습니다.' : '조회 기간에 거래 내역이 없습니다.'
}
