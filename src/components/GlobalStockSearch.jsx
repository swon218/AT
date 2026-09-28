import { useEffect, useId, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { searchKiwoomStocks } from '../services/kiwoomMarketApi'

export default function GlobalStockSearch({ onSelect, credentialScope }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [composing, setComposing] = useState(false)
  const listId = useId()
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const term = query.trim()
  const current = result?.term === term && result?.scope === credentialScope ? result : null
  const items = current?.items || []
  const expanded = open && Boolean(term)

  useEffect(() => {
    if (!term || composing) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      searchKiwoomStocks(term, controller.signal)
        .then(data => { if (!controller.signal.aborted) { setResult({ ...data, term, scope: credentialScope }); setActiveIndex(0) } })
        .catch(error => { if (!controller.signal.aborted) setResult({ term, scope: credentialScope, items: [], error: error.message }) })
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, term, composing, credentialScope])

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, current, expanded])

  const select = (stock) => {
    if (!stock) return
    setQuery(''); setResult(null); setOpen(false); setActiveIndex(0)
    inputRef.current?.blur()
    onSelect({ ...stock, price: null, change: null })
  }

  const onKeyDown = (event) => {
    if (composing || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') { setOpen(false); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      if (items.length) setActiveIndex(index => !open ? 0 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
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
      onChange={event => { setQuery(event.target.value); setResult(null); setOpen(true); setActiveIndex(0) }}
      onFocus={() => setOpen(true)} onKeyDown={onKeyDown}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}/>
    {expanded && <div className="search-results">
      <div className="stock-search-status" role="status">{current?.error || (!current || composing ? '종목을 검색하고 있습니다…' : items.length ? `${current.total}개 종목${current.total > items.length ? ' · 상위 50개 표시' : ''}` : '일치하는 종목이 없습니다.')}</div>
      <div ref={listRef} id={listId} role="listbox" aria-label="종목 검색 결과" className="stock-search-list">
        {items.map((stock, index) => <button key={stock.code} id={`${listId}-${index}`} type="button" role="option" aria-selected={activeIndex === index} tabIndex={-1}
          onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActiveIndex(index)} onClick={() => select(stock)}>
          <span><strong>{stock.name}</strong><small>{stock.code}</small></span><b>{stock.market === 'KOSDAQ' ? '코스닥' : '코스피'}</b>
        </button>)}
      </div>
      {items.length > 0 && <div className="stock-search-help">↑↓ 이동 · Enter 선택 · Esc 닫기</div>}
    </div>}
  </div>
}
