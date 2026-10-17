import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { stockCatalog } from '../services/stockCatalog'
import { indexStockCatalog, searchStockCatalog } from '../utils/stockSearch.js'

const emptyItems = []

export default function GlobalStockSearch({ onSelect, credentialScope }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [catalogState, setCatalogState] = useState(() => ({ scope: credentialScope, catalog: stockCatalog.read(credentialScope) }))
  const [retryVersion, setRetryVersion] = useState(0)
  const [visibleLimit, setVisibleLimit] = useState(50)
  const [activeIndex, setActiveIndex] = useState(0)
  const [composing, setComposing] = useState(false)
  const listId = useId()
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const term = query.trim()
  const current = catalogState.scope === credentialScope ? catalogState : null
  const catalogItems = current?.catalog?.items || emptyItems
  const index = useMemo(() => indexStockCatalog(catalogItems), [catalogItems])
  const result = useMemo(() => searchStockCatalog(index, term, visibleLimit), [index, term, visibleLimit])
  const items = result.items
  const expanded = open && Boolean(term)
  let status = !current?.catalog ? current?.error || '검색용 종목 목록을 준비하고 있습니다…'
    : items.length ? `${result.total}개 종목${result.total > items.length ? ` · ${items.length}개 표시 · 아래로 스크롤하면 더 표시` : ''}` : '일치하는 종목이 없습니다.'
  if (current?.catalog && (current.error || current.catalog.stale)) status += ' · 목록 갱신 대기 중'

  useEffect(() => {
    let disposed = false
    setCatalogState({ scope: credentialScope, catalog: stockCatalog.read(credentialScope) })
    const refresh = () => stockCatalog.load(credentialScope)
      .then(catalog => { if (!disposed) setCatalogState({ scope: credentialScope, catalog }) })
      .catch(error => { if (!disposed) setCatalogState({ scope: credentialScope, catalog: stockCatalog.read(credentialScope), error: error.message }) })
    refresh()
    // Check freshness without tying network traffic to typing; retry failed refreshes.
    const timer = setInterval(refresh, 60_000)
    return () => { disposed = true; clearInterval(timer) }
  }, [credentialScope, retryVersion])

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, term, expanded])

  const select = (stock) => {
    if (!stock) return
    setQuery(''); setOpen(false); setActiveIndex(0); setVisibleLimit(50)
    inputRef.current?.blur()
    onSelect({ ...stock, price: null, change: null })
  }

  const onKeyDown = (event) => {
    if (composing || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') { setOpen(false); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      if (event.key === 'ArrowDown' && open && activeIndex === items.length - 1 && items.length < result.total) {
        setVisibleLimit(limit => limit + 50)
        setActiveIndex(index => index + 1)
      } else if (items.length) setActiveIndex(index => !open ? 0 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (expanded) select(items[activeIndex] || items[0])
      else setOpen(true)
    }
  }

  return <div className="global-search" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <Search aria-hidden="true"/>
    <input ref={inputRef} role="combobox" aria-label="전체 종목 검색" aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? listId : undefined} aria-activedescendant={expanded && items[activeIndex] ? `${listId}-${activeIndex}` : undefined}
      autoComplete="off" maxLength={40} placeholder="종목명 또는 종목코드 검색" value={query}
      onChange={event => { setQuery(event.target.value); setOpen(true); setActiveIndex(0); setVisibleLimit(50); if (listRef.current) listRef.current.scrollTop = 0 }}
      onFocus={() => setOpen(true)} onKeyDown={onKeyDown}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}/>
    {expanded && <div className="search-results">
      <div className="stock-search-status" role="status">{status}</div>
      {!current?.catalog && current?.error && <button type="button" onClick={() => setRetryVersion(value => value + 1)}>다시 시도</button>}
      <div ref={listRef} id={listId} role="listbox" aria-label="종목 검색 결과" className="stock-search-list" onScroll={event => {
        const list = event.currentTarget
        if (list.scrollHeight - list.scrollTop - list.clientHeight < 60 && items.length < result.total) setVisibleLimit(limit => limit + 50)
      }}>
        {items.map((stock, index) => <button key={stock.code} id={`${listId}-${index}`} type="button" role="option" aria-selected={activeIndex === index} tabIndex={-1}
          onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActiveIndex(index)} onClick={() => select(stock)}>
          <span><strong>{stock.name}</strong><small>{stock.code}</small></span><b>{stock.market === 'KOSDAQ' ? '코스닥' : '코스피'}</b>
        </button>)}
      </div>
      {items.length > 0 && <div className="stock-search-help">↑↓ 이동 · Enter 선택 · Esc 닫기</div>}
    </div>}
  </div>
}
