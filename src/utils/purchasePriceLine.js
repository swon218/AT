const formatter = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 6 })

export const purchasePriceLabel = price => `내 평균 매입가 ${formatter.format(price)}원`
const validPrice = price => typeof price === 'number' && Number.isFinite(price) && price > 0
const colors = palette => palette.background === '#ffffff'
  ? { color: '#087e53', axisLabelColor: '#087e53', axisLabelTextColor: '#ffffff' }
  : { color: '#47d69a', axisLabelColor: '#47d69a', axisLabelTextColor: '#081d18' }

// Owns exactly one native price line on the candle series. Updating it never
// changes candle data, the time scale, indicator panes, or network requests.
export function createPurchasePriceLine(series, initialPalette) {
  let line = null, price = null, palette = initialPalette, disposed = false, restoration = null
  function restoreScale() {
    if (!restoration) return
    const scale = series.priceScale(), current = scale.getVisibleRange()
    const near = (a, b) => Math.abs(a - b) <= Math.max(1, Math.abs(b)) * 1e-9
    if (current && near(current.from, restoration.revealed.from) && near(current.to, restoration.revealed.to)) {
      if (restoration.autoScale) scale.applyOptions({ autoScale: true })
      else scale.setVisibleRange(restoration.original)
    }
    restoration = null
  }
  function setPrice(next) {
    if (disposed) return
    price = validPrice(next) ? next : null
    if (price === null) {
      if (line) series.removePriceLine(line)
      line = null
      restoreScale()
      return
    }
    const options = {
      id: 'atlas-personal-average-price', price, ...colors(palette),
      lineWidth: 2, lineStyle: 2, lineVisible: true, axisLabelVisible: true,
      title: purchasePriceLabel(price),
    }
    if (line) line.applyOptions(options)
    else line = series.createPriceLine(options)
  }
  return {
    setPrice,
    setPalette(next) {
      if (disposed) return
      palette = next
      if (line) line.applyOptions(colors(palette))
    },
    reveal() {
      if (disposed || price === null) return false
      const scale = series.priceScale(), range = scale.getVisibleRange()
      if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return false
      if (price >= range.from && price <= range.to) return true
      const from = Math.min(range.from, price), to = Math.max(range.to, price)
      const margin = Math.max((to - from) * 0.06, price * 0.001)
      // Only an explicit click changes the price range. Horizontal zoom and
      // scroll are untouched and no fitContent is used for this overlay.
      restoration ??= { original: range, autoScale: scale.options().autoScale }
      const expanded = { from: Math.max(0, from - margin), to: to + margin }
      scale.setVisibleRange(expanded)
      restoration.revealed = scale.getVisibleRange() || expanded
      return true
    },
    dispose() {
      if (disposed) return
      setPrice(null)
      disposed = true
    },
  }
}
