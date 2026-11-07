import { Star } from 'lucide-react'
import { watchlistCode } from '../services/watchlistRepository'
import './WatchlistStar.css'

export default function WatchlistStar({ stock, watchlist }) {
  const code = watchlistCode(stock.code)
  const saved = watchlist.rows.some(row => row.code === code)
  const label = `${stock.name} 관심종목 ${saved ? '삭제' : '추가'}`
  return <button type="button" className="watchlist-star" aria-label={label} title={label}
    aria-pressed={saved} aria-disabled={!watchlist.canToggle || undefined}
    aria-busy={watchlist.pendingCode === code || undefined}
    onClick={() => { if (watchlist.canToggle) void watchlist.toggle(stock) }}>
    <Star size={17} aria-hidden="true"/>
  </button>
}

export function WatchlistFeedback({ watchlist }) {
  if (!watchlist.readError && !watchlist.mutationError) return null
  return <div className="watchlist-feedback">
    {watchlist.mutationError && <p role="alert">{watchlist.mutationError}</p>}
    {watchlist.readError && <p role="alert">{watchlist.readError}{' '}
      <button type="button" onClick={watchlist.refresh}>다시 시도</button>
    </p>}
  </div>
}
