export const PURCHASE_PRICE_FRESH_MS = 30_000

export function isPurchasePriceFresh(receivedAt, now = Date.now()) {
  return typeof receivedAt === 'number' && Number.isFinite(receivedAt)
    && typeof now === 'number' && Number.isFinite(now)
    && receivedAt > 0 && now >= receivedAt && now - receivedAt <= PURCHASE_PRICE_FRESH_MS
}

const messages = {
  guest: '로그인 후 사용할 수 있습니다.',
  unconfigured: '선택한 증권사의 API를 등록해 주세요.',
  accountRequired: '계좌를 선택해 주세요.',
  loading: '보유정보 확인 중',
  error: '보유정보를 확인할 수 없습니다.',
  scopeMismatch: '선택한 계좌의 보유정보를 다시 확인해 주세요.',
  stockRequired: '표시할 종목을 선택해 주세요.',
  notHeld: '선택한 계좌에 보유한 종목이 없습니다.',
  quantityMissing: '보유수량을 확인할 수 없습니다.',
  quantityBasisUnsupported: 'KB 보유·정산수량이 일치하고 미결제 매수·매도 수량이 0인 보유분만 표시할 수 있습니다.',
  priceMissing: '평균 매입가를 확인할 수 없습니다.',
  ambiguous: '같은 종목의 보유 구분이 여러 개여서 평균 매입가를 표시할 수 없습니다.',
  ready: '선택한 계좌의 현재 보유분 평균 매입가입니다.',
}
const result = (status, price = null) => ({status, message: messages[status], price, available: status === 'ready'})
const stockCode = value => typeof value === 'string' && /^[0-9][0-9A-Z]{5}$/.test(value.trim().toUpperCase()) ? value.trim().toUpperCase() : null
const finite = value => typeof value === 'number' && Number.isFinite(value)

// Display numbers come exclusively from the selected personal account summary.
// Never infer a cost basis from the current quote, orderable shares or valuation.
export function derivePurchasePrice({userId, configured, broker, accountId = '', stockCode: symbol, summary, status}) {
  if (!userId) return result('guest')
  if (!configured) return result('unconfigured')
  if (status === 'error') return result('error')
  if (status === 'loading' || status === 'idle') return result('loading')
  if (status === 'accountRequired' || summary?.accountRequired) return result('accountRequired')
  if (status !== 'ready' || !summary || !['kiwoom', 'toss', 'nh', 'kb'].includes(broker)) return result('error')
  if (summary.broker !== broker) return result('scopeMismatch')
  if (broker === 'nh' && !summary.selectedAccountId) return result('accountRequired')
  if (accountId && summary.selectedAccountId !== accountId) return result('scopeMismatch')
  const code = stockCode(symbol)
  if (!code) return result('stockRequired')
  if (!Array.isArray(summary.holdings) || summary.holdings.some(row => !row || !stockCode(row.code))) return result('error')
  const matches = summary.holdings.filter(row => stockCode(row.code) === code)
  if (!matches.length) return result('notHeld')
  // KB's old asset quantity is a settlement field. Only use the independently
  // verified common holding/settlement subset for this optional overlay.
  if (broker === 'kb' && matches.some(row => row.purchasePriceQuantityStatus !== 'verified' || !finite(row.purchasePriceQuantity) || row.purchasePriceQuantity < 0)) return result('quantityBasisUnsupported')
  const quantity = row => broker === 'kb' ? row.purchasePriceQuantity : row.quantity
  if (matches.some(row => !finite(quantity(row)) || quantity(row) < 0)) return result('quantityMissing')
  const held = matches.filter(row => quantity(row) > 0)
  if (!held.length) return result('notHeld')
  if (held.length !== 1) return result('ambiguous')
  const price = held[0].averagePrice
  if (!finite(price) || price <= 0) return result('priceMissing')
  return result('ready', price)
}
