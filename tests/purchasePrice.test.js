import test from 'node:test'
import assert from 'node:assert/strict'
import {derivePurchasePrice, isPurchasePriceFresh, PURCHASE_PRICE_FRESH_MS} from '../src/utils/purchasePrice.js'

const holding = {code: '005930', quantity: 10, averagePrice: 200_000, tradableQuantity: 10}
const args = (overrides = {}) => ({userId: 'fixture-user', configured: true, broker: 'toss', stockCode: '005930', status: 'ready', summary: {broker: 'toss', holdings: [holding]}, ...overrides})
const derive = overrides => derivePurchasePrice(args(overrides))
const withRows = rows => ({summary: {broker: 'toss', holdings: rows}})

test('personal credentials are required independently for the selected broker and guest state takes priority', () => {
  assert.equal(derive({userId: ''}).status, 'guest')
  assert.equal(derive({userId: '', configured: false, status: 'error'}).message, '로그인 후 사용할 수 있습니다.')
  assert.equal(derive({configured: false}).status, 'unconfigured')
  assert.equal(derive().price, 200_000)
  assert.equal(derive({broker: 'kiwoom', configured: false}).price, null)
  assert.equal(derive({broker: 'kiwoom'}).status, 'scopeMismatch')
  assert.equal(derive({broker: 'kb'}).available, false)
})

test('account loading and failures hide old successful holdings rather than implying no holdings', () => {
  assert.equal(derive({status: 'loading'}).status, 'loading')
  assert.equal(derive({status: 'idle'}).status, 'loading')
  assert.equal(derive({status: 'error'}).status, 'error')
  assert.equal(derive({status: 'error'}).price, null)
  assert.equal(derive({summary: null}).status, 'error')
  assert.equal(derive({summary: {broker: 'toss'}}).status, 'error')
  assert.equal(derive({summary: {broker: 'toss', holdings: null}}).status, 'error')
  assert.equal(derive({status: 'unknown'}).status, 'error')
})

test('NH requires the selected owned account and explicit account mismatches cannot reuse another summary', () => {
  const summary = {broker: 'nh', selectedAccountId: 'opaque-account-a', holdings: [holding]}
  assert.equal(derive({broker: 'nh', summary, accountId: 'opaque-account-a'}).price, 200_000)
  assert.equal(derive({broker: 'nh', summary, accountId: 'opaque-account-b'}).status, 'scopeMismatch')
  assert.equal(derive({broker: 'nh', summary: {...summary, selectedAccountId: ''}}).status, 'accountRequired')
  assert.equal(derive({broker: 'nh', summary: {...summary, accountRequired: true}}).status, 'accountRequired')
  assert.equal(derive({status: 'accountRequired', summary: null}).status, 'accountRequired')
  assert.equal(derive({accountId: 'opaque-account-a'}).status, 'scopeMismatch')
})

test('uses reported current weighted average and current holdings, not orderable shares or order prices', () => {
  const blocked = {...holding, quantity: 7, tradableQuantity: 0, averagePrice: 210_500, currentPrice: 190_000, purchaseAmount: 1_234, orderPrice: 500_000}
  assert.equal(derive(withRows([blocked])).price, 210_500)
  assert.equal(derive(withRows([{...blocked, quantity: 3}])).price, 210_500)
  assert.equal(derive(withRows([{...blocked, quantity: 0}])).status, 'notHeld')
  assert.equal(derive(withRows([])).status, 'notHeld')
  const openBuy = {...holding, quantity: 0, pendingBuyQuantity: 10, orderPrice: 200_000}
  assert.equal(derive(withRows([openBuy])).price, null)
})

test('KB uses only the explicitly verified common quantity and never guesses from settlement or sellable shares', () => {
  const summary = {broker:'kb',holdings:[holding]}
  assert.equal(derive({broker:'kb',summary}).status,'quantityBasisUnsupported')
  const row={...holding,quantity:99,tradableQuantity:0,purchasePriceQuantity:10,purchasePriceQuantityStatus:'verified'}
  assert.equal(derive({broker:'kb',summary:{...summary,holdings:[row]}}).price,200000)
  assert.equal(derive({broker:'kb',summary:{...summary,holdings:[{...row,purchasePriceQuantity:0}]}}).status,'notHeld')
  for(const patch of [{purchasePriceQuantity:null},{purchasePriceQuantityStatus:'unconfirmed'},{purchasePriceQuantity:-1}]){
    assert.equal(derive({broker:'kb',summary:{...summary,holdings:[{...row,...patch}]}}).status,'quantityBasisUnsupported')
  }
})

test('missing quantities and cost basis never fall back to zero, current prices, value or strings', () => {
  for (const quantity of [undefined, null, NaN, Infinity, -1, '10', true]) {
    const value = derive(withRows([{...holding, quantity}]))
    assert.equal(value.status, 'quantityMissing', String(quantity))
    assert.equal(value.price, null)
  }
  for (const averagePrice of [undefined, null, NaN, Infinity, -1, 0, '200000', true]) {
    const value = derive(withRows([{...holding, averagePrice, currentPrice: 200_000, purchaseAmount: 2_000_000}]))
    assert.equal(value.status, 'priceMissing', String(averagePrice))
    assert.equal(value.price, null)
  }
})

test('duplicate positive positions are ambiguous and unknown matching quantities cannot be silently ignored', () => {
  assert.equal(derive(withRows([holding, {...holding, averagePrice: 190_000}])).status, 'ambiguous')
  assert.equal(derive(withRows([holding, {...holding, quantity: null}])).status, 'quantityMissing')
  assert.equal(derive(withRows([holding, {...holding, quantity: 0, averagePrice: null}])).price, 200_000)
  assert.equal(derive(withRows([{...holding, quantity: 0}, {...holding, quantity: 0}])).status, 'notHeld')
})

test('normalizes existing six-character codes without inventing leading zeros or stripping unknown prefixes', () => {
  assert.equal(derive({stockCode: ' 005930 '}).price, 200_000)
  assert.equal(derive({...withRows([{...holding, code: '0009k0'}]), stockCode: '0009K0'}).price, 200_000)
  assert.equal(derive({stockCode: '5930'}).status, 'stockRequired')
  assert.equal(derive({stockCode: 5930}).status, 'stockRequired')
  assert.equal(derive({stockCode: 'A005930'}).status, 'stockRequired')
  assert.equal(derive({stockCode: '000660'}).status, 'notHeld')
  assert.equal(derive(withRows([{...holding, code: ''}])).status, 'error')
  assert.equal(derive(withRows([null])).status, 'error')
})

test('only bounded fresh successful snapshots are reusable; future and malformed clocks are rejected', () => {
  const now = 1_800_000_000_000
  assert.equal(isPurchasePriceFresh(now, now), true)
  assert.equal(isPurchasePriceFresh(now - PURCHASE_PRICE_FRESH_MS, now), true)
  assert.equal(isPurchasePriceFresh(now - PURCHASE_PRICE_FRESH_MS - 1, now), false)
  assert.equal(isPurchasePriceFresh(now + 1, now), false)
  for (const receivedAt of [undefined, null, NaN, Infinity, 0, -1, String(now)]) assert.equal(isPurchasePriceFresh(receivedAt, now), false)
  assert.equal(isPurchasePriceFresh(now, NaN), false)
  assert.equal(isPurchasePriceFresh(now, String(now)), false)
})
