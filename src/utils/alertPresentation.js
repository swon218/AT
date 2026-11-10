export const stateLabels = {
  active: '감시 중', stopped: '중지', expired: '만료', queued: '조건 충족 · 발송 대기',
  sending: '카카오 발송 요청 중', sent: '발송 완료', failed: '발송 실패',
  unknown: '발송 결과 확인 불가', canceled: '취소',
}

export const reasons = {
  reference_or_quote_unavailable: '검증된 시세 또는 비교 기준가 확인 불가',
  quote_unavailable: '시세 확인 불가', kakao_required: '카카오 재연결 또는 메시지 동의 필요',
  watchlist_removed: '관심종목 삭제', event_stale: '관측 시각 만료', expired: '만료일 경과',
  quota: '카카오 발송 한도', market_closed: '정규장 종료', rule_replaced: '조건 변경 전 발송 대기 취소',
}

export function displayAlertStatus(rule, today) {
  return rule.expires_on < today && ['active', 'stopped', 'queued'].includes(rule.status) ? 'expired' : rule.status
}
