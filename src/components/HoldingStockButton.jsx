import { watchlistCode } from '../services/watchlistRepository'

export default function HoldingStockButton({ holding, onOpenStock }) {
  const code = watchlistCode(holding.code)
  const name = holding.name || code
  const label = <><strong>{name}</strong><small>{holding.code}</small></>
  if (!code || !onOpenStock) return <span className="holding-stock-control">{label}</span>

  return <button type="button" className="holding-stock-control" aria-label={`${name} (${code}) 주식 주문 탭에서 열기`}
    onClick={() => onOpenStock({ code, name, market: holding.market || null, price: null, change: null, volume: null })}>
    {label}
  </button>
}
