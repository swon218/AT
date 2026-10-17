import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { indexStockCatalog, nextStockSearchIndex, searchStockCatalog } from '../utils/stockSearch.js'

const emptyItems = []
const selectable = () => true

export default function StockSearch({ catalogItems = emptyItems, ready = true, error = '', stale = false, onRetry, onSelect,
  inputLabel = '전체 종목 검색', listLabel = '종목 검색 결과', placeholder = '종목명 또는 종목코드 검색', className = '',
  isSelectable = selectable, getOptionNote }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [visibleLimit, setVisibleLimit] = useState(50)
  const [composing, setComposing] = useState(false)
  const listId = useId()
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const term = query.trim()
  const index = useMemo(() => indexStockCatalog(catalogItems), [catalogItems])
  const result = useMemo(() => searchStockCatalog(index, term, Infinity), [index, term])
  const firstSelectable = result.items.findIndex(isSelectable)
  const selectedIndex = result.items[activeIndex] && isSelectable(result.items[activeIndex]) ? activeIndex : firstSelectable
  const items = result.items.slice(0, Math.max(visibleLimit, selectedIndex + 1))
  const expanded = open && Boolean(term)
  let status = !ready ? error || '검색용 종목 목록을 준비하고 있습니다…'
    : items.length ? `${result.total}개 종목${result.total > items.length ? ` · ${items.length}개 표시 · 아래로 스크롤하면 더 표시` : ''}` : '일치하는 종목이 없습니다.'
  if (ready && (error || stale)) status += ' · 목록 갱신 대기 중'

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, term, expanded])

  const select = stock => {
    if (!stock || !isSelectable(stock)) return
    setQuery(''); setOpen(false); setActiveIndex(0); setVisibleLimit(50)
    inputRef.current?.blur()
    onSelect(stock)
  }

  const onKeyDown = event => {
    if (composing || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') { setOpen(false); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      const next = nextStockSearchIndex(result.items, open ? selectedIndex : -1, !open || event.key === 'ArrowDown' ? 1 : -1, isSelectable)
      setActiveIndex(next)
      if (next >= visibleLimit) setVisibleLimit(Math.ceil((next + 1) / 50) * 50)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (expanded) select(result.items[selectedIndex])
      else setOpen(true)
    }
  }

  return <div className={`global-search ${className}`.trim()} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <Search aria-hidden="true"/>
    <input ref={inputRef} role="combobox" aria-label={inputLabel} aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? listId : undefined} aria-activedescendant={expanded && selectedIndex >= 0 ? `${listId}-${selectedIndex}` : undefined}
      autoComplete="off" maxLength={40} placeholder={placeholder} value={query}
      onChange={event => { setQuery(event.target.value); setOpen(true); setActiveIndex(0); setVisibleLimit(50); if (listRef.current) listRef.current.scrollTop = 0 }}
      onFocus={() => setOpen(true)} onKeyDown={onKeyDown}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}/>
    {expanded && <div className="search-results">
      <div className="stock-search-status" role="status">{status}</div>
      {!ready && error && onRetry && <button type="button" onClick={onRetry}>다시 시도</button>}
      <div ref={listRef} id={listId} role="listbox" aria-label={listLabel} className="stock-search-list" onScroll={event => {
        const list = event.currentTarget
        if (list.scrollHeight - list.scrollTop - list.clientHeight < 60 && items.length < result.total) setVisibleLimit(limit => Math.max(limit, items.length) + 50)
      }}>
        {items.map((stock, optionIndex) => <button key={stock.code} id={`${listId}-${optionIndex}`} type="button" role="option" aria-selected={selectedIndex === optionIndex} aria-disabled={!isSelectable(stock)} disabled={!isSelectable(stock)} tabIndex={-1}
          onMouseDown={event => event.preventDefault()} onMouseMove={() => { if (isSelectable(stock)) setActiveIndex(optionIndex) }} onClick={() => select(stock)}>
          <span><strong>{stock.name}</strong><small>{stock.code}{getOptionNote?.(stock) && ` · ${getOptionNote(stock)}`}</small></span><b>{stock.market === 'KOSDAQ' ? '코스닥' : stock.market === 'KOSPI' ? '코스피' : stock.market || 'KRX'}</b>
        </button>)}
      </div>
      {items.length > 0 && <div className="stock-search-help">↑↓ 이동 · Enter 선택 · Esc 닫기</div>}
    </div>}
  </div>
}
