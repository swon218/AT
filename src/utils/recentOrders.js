import { BROKERS } from './brokers.js'

export const orderStatusLabels = { filled: '체결 완료', partiallyFilled: '부분체결', residualCancelled: '잔량취소', cancelled: '전량 취소', rejected: '거절', pending: '접수·미체결', replaced: '정정됨', unknown: '상태 확인 필요' }
export const recentOrderScope = (userId, status, version, accountRefs, selected) => JSON.stringify([userId, BROKERS.map(({ id }) => Boolean(status?.[`${id}Configured`])), version, accountRefs, selected])

export function recentOrdersEmptyMessage(data) {
  const brokers = data?.brokers?.filter(broker => broker.status !== 'unconfigured') || []
  if (!brokers.length) return '조회 가능한 증권사가 없습니다.'
  if (brokers.some(broker => broker.status === 'error')) return '거래 내역을 불러오지 못했습니다.'
  if (brokers.some(broker => broker.status === 'accountRequired')) return '조회 계좌를 선택해주세요.'
  return brokers.every(broker => broker.status === 'ready') ? '최근 거래 내역이 없습니다' : '거래 내역을 불러오지 못했습니다.'
}

// Request ownership is checked both before rendering and when a promise settles.
// Aborting alone cannot prevent a late result from a transport that ignores abort.
export function createOrderRequestGuard() {
  let current = 0
  return { next: () => ++current, cancel: () => { current++ }, isCurrent: value => current === value }
}
