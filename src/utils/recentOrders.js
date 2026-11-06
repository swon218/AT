import { BROKERS } from './brokers.js'

export const missingOrderBrokers = status => BROKERS.filter(({ id }) => !status?.[`${id}Configured`])
export const orderStatusLabels = { filled: '체결 완료', partiallyFilled: '부분체결', residualCancelled: '잔량취소', cancelled: '전량 취소', rejected: '거절', pending: '접수·미체결', replaced: '정정됨', unknown: '상태 확인 필요' }
export const recentOrderScope = (userId, status, version, accountRefs, revision) => JSON.stringify([userId, BROKERS.map(({ id }) => Boolean(status?.[`${id}Configured`])), version, accountRefs, revision])

// Request ownership is checked both before rendering and when a promise settles.
// Aborting alone cannot prevent a late result from a transport that ignores abort.
export function createOrderRequestGuard() {
  let current = 0
  return { next: () => ++current, cancel: () => { current++ }, isCurrent: value => current === value }
}
