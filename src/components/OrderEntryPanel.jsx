import { AlertTriangle, CheckCircle2, Info, KeyRound, LogIn, Minus, Plus, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { INDICATOR_CATALOG } from '../utils/indicators'
import { placeBrokerOrder } from '../services/orderApi'

const onlyNumber = (value) => value.replace(/[^0-9]/g, '')

function FieldRow({ label, children }) {
  return <div className="trade-field"><label>{label}</label><div>{children}</div></div>
}

function StepInput({ value, onChange, placeholder, unit }) {
  const step = (amount) => onChange(String(Math.max(0, Number(value || 0) + amount)))
  return (
    <div className="step-input-wrap">
      <div className="trade-input unit-input"><input inputMode="numeric" value={value} onChange={(event) => onChange(onlyNumber(event.target.value))} placeholder={placeholder}/><b>{unit}</b></div>
      <button type="button" aria-label={`${unit} 감소`} onClick={() => step(-1)}><Minus/></button>
      <button type="button" aria-label={`${unit} 증가`} onClick={() => step(1)}><Plus/></button>
    </div>
  )
}

function OrderAccessNotice({ authenticated, broker, brokerConfigured }) {
  const brokerName = broker === 'toss' ? '토스증권' : '키움증권'
  if (!authenticated) return <p className="order-login-warning"><LogIn/>로그인 후 본인의 {brokerName} API 키를 등록하면 주문할 수 있습니다.</p>
  if (!brokerConfigured) return <p className="order-login-warning"><KeyRound/>운영자 {brokerName} API로 차트만 표시됩니다. 개인 설정에서 {brokerName} API를 저장하면 계좌 조회와 주문을 이용할 수 있습니다.</p>
  return <p className="order-login-warning ready"><CheckCircle2/>사용자 {brokerName} API가 연결되었습니다. 실제 주문 전 종목, 가격, 수량을 반드시 확인하세요.</p>
}

function OrderConfirmDialog({ draft, stock, broker, pending, error, onCancel, onConfirm }) {
  if (!draft) return null
  const sideLabel = draft.side === 'buy' ? '매수' : '매도'
  const priceLabel = draft.session !== 'regular'
    ? draft.session === 'pre' ? '장전 시간외' : '장후 시간외'
    : draft.priceType === 'market' ? '시장가' : `${Number(draft.price).toLocaleString('ko-KR')}원`
  return createPortal(
    <div className="auth-overlay order-confirm-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onCancel() }}>
      <section className="order-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="order-confirm-title">
        <button type="button" className="auth-close" aria-label="주문 확인 닫기" onClick={onCancel} disabled={pending}><X/></button>
        <span className={`order-confirm-icon ${draft.side}`}><AlertTriangle/></span>
        <h2 id="order-confirm-title">실제 {sideLabel} 주문을 전송할까요?</h2>
        <dl>
          <div><dt>증권사</dt><dd>{broker === 'toss' ? '토스증권' : '키움증권'}</dd></div>
          <div><dt>종목</dt><dd>{stock?.name || '-'} ({draft.symbol})</dd></div>
          <div><dt>구분</dt><dd>{sideLabel}</dd></div>
          <div><dt>가격</dt><dd>{priceLabel}</dd></div>
          <div><dt>수량</dt><dd>{Number(draft.quantity).toLocaleString('ko-KR')}주</dd></div>
        </dl>
        <p>확인을 누르면 저장된 본인의 {broker === 'toss' ? '토스증권' : '키움증권'} API 키로 실제 주문이 전송됩니다.</p>
        {error && <p className="order-submit-message error" role="alert">{error}</p>}
        <div className="order-confirm-actions"><button type="button" onClick={onCancel} disabled={pending}>취소</button><button type="button" className={draft.side} onClick={onConfirm} disabled={pending}>{pending ? '전송 중...' : `${sideLabel} 주문 확정`}</button></div>
      </section>
    </div>,
    document.body,
  )
}

function GeneralOrder({ stock, authenticated, broker, brokerConfigured, accountSummary, accountLoading, accountError, onAccountRefresh }) {
  const [side, setSide] = useState('buy')
  const [orderSession, setOrderSession] = useState('regular')
  const [priceType, setPriceType] = useState('limit')
  const [price, setPrice] = useState('')
  const [quantity, setQuantity] = useState('')
  const [draft, setDraft] = useState(null)
  const [pending, setPending] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [submitMessage, setSubmitMessage] = useState('')
  const [validationMessage, setValidationMessage] = useState('')
  const total = useMemo(() => Number(price || 0) * Number(quantity || 0), [price, quantity])
  const ready = authenticated && brokerConfigured
  const needsLimitPrice = orderSession === 'regular' && priceType === 'limit'
  const selectedHolding = accountSummary?.holdings?.find((item) => item.code === stock?.code)
  const validStock = /^\d{6}$/.test(stock?.code || '')
  const validQuantity = Number(quantity) > 0
  const validPrice = !needsLimitPrice || Number(price) > 0
  const canSubmit = ready && validStock && validQuantity && validPrice
  const capacityWarning = accountSummary && validQuantity
    ? side === 'buy' && needsLimitPrice && total > Number(accountSummary.orderableAmount || 0)
      ? `입력한 주문금액이 조회된 주문 가능 금액 ${Number(accountSummary.orderableAmount || 0).toLocaleString('ko-KR')}원을 초과합니다. 최종 가능 여부는 증권사에서 확인합니다.`
      : side === 'sell' && Number(quantity) > Number(selectedHolding?.tradableQuantity || 0)
        ? `입력한 수량이 조회된 매도 가능 수량 ${Number(selectedHolding?.tradableQuantity || 0).toLocaleString('ko-KR')}주를 초과합니다. 최종 가능 여부는 증권사에서 확인합니다.`
        : ''
    : ''
  const orderButtonGuide = !ready
    ? '로그인 후 선택한 증권사 API를 연결해 주세요.'
    : !validStock
      ? '주문할 종목을 선택해 주세요.'
      : !validQuantity
        ? '주문수량을 입력하면 주문 버튼이 활성화됩니다.'
        : !validPrice
          ? '주문가격을 입력하면 주문 버튼이 활성화됩니다.'
          : ''

  useEffect(() => {
    setOrderSession('regular')
    setPriceType('limit')
    setPrice('')
    setQuantity('')
    setDraft(null)
    setSubmitError('')
    setSubmitMessage('')
    setValidationMessage('')
  }, [broker])

  const openConfirmation = () => {
    if (!canSubmit) {
      setValidationMessage(orderButtonGuide)
      return
    }
    setValidationMessage('')
    setSubmitError('')
    setSubmitMessage('')
    setDraft({
      side,
      symbol: stock.code,
      exchange: ['KRX', 'NXT', 'SOR'].includes(stock.market) ? stock.market : 'KRX',
      session: orderSession,
      priceType,
      price,
      quantity,
      clientRequestId: globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`,
    })
  }

  const submitOrder = async () => {
    if (!draft || pending) return
    setPending(true)
    setSubmitError('')
    try {
      const result = await placeBrokerOrder(broker, draft)
      setDraft(null)
      setQuantity('')
      if (priceType === 'limit') setPrice('')
      setSubmitMessage(`${result.message}${result.orderNumber ? ` · 주문번호 ${result.orderNumber}` : ''}`)
      onAccountRefresh?.()
    } catch (error) {
      setSubmitError(error.message)
    } finally {
      setPending(false)
    }
  }

  if (side === 'open') return (
    <>
      <div className="side-tabs"><button onClick={() => setSide('buy')}>매수</button><button onClick={() => setSide('sell')}>매도</button><button className="active open" onClick={() => setSide('open')}>미체결</button></div>
      <div className="unfilled-empty"><Info/><span>{broker === 'toss' ? '토스증권' : '키움증권'} 미체결 주문 조회는 다음 단계에서 연결됩니다.</span></div>
      <OrderAccessNotice authenticated={authenticated} broker={broker} brokerConfigured={brokerConfigured}/>
    </>
  )

  return (
    <>
      <div className="side-tabs"><button className={side === 'buy' ? 'active buy' : ''} onClick={() => setSide('buy')}>매수</button><button className={side === 'sell' ? 'active sell' : ''} onClick={() => setSide('sell')}>매도</button><button onClick={() => setSide('open')}>미체결</button></div>
      <div className="trade-form">
        <FieldRow label="주문 유형"><select className="trade-input" value={orderSession} onChange={(event) => { const next = event.target.value; setOrderSession(next); if (next !== 'regular') { setPriceType('market'); setPrice('') } }}><option value="regular">정규장 주문</option>{broker === 'kiwoom' && <><option value="pre">장전 시간외</option><option value="post">장후 시간외</option></>}</select></FieldRow>
        <FieldRow label="주문 가격">
          <div className="price-type-tabs"><button disabled={orderSession !== 'regular'} className={priceType === 'limit' ? 'active' : ''} onClick={() => setPriceType('limit')}>지정가</button><button disabled={orderSession !== 'regular'} className={priceType === 'market' ? 'active' : ''} onClick={() => { setPriceType('market'); setPrice('') }}>시장가</button></div>
          {priceType === 'limit' && <StepInput value={price} onChange={setPrice} placeholder="가격 입력" unit="원"/>}
        </FieldRow>
        <FieldRow label="주문수량"><StepInput value={quantity} onChange={setQuantity} placeholder="수량 입력" unit="주"/></FieldRow>
        <FieldRow label="총 주문 금액"><div className="trade-input readonly"><span>{needsLimitPrice ? `${total.toLocaleString('ko-KR')}원` : '시장가 주문'}</span></div></FieldRow>
        {side === 'buy'
          ? <FieldRow label="주문 가능 금액"><div className="trade-input readonly"><span>{!ready ? 'API 연결 필요' : accountLoading ? '조회 중...' : accountSummary ? `${Number(accountSummary.orderableAmount || 0).toLocaleString('ko-KR')}원` : '조회 실패'}</span></div></FieldRow>
          : <SellAccountPreview ready={ready} loading={accountLoading} holding={selectedHolding}/>}
      </div>
      <button className={`order-execute ${side}`} disabled={!ready || pending} onClick={openConfirmation}>{side === 'buy' ? '매수 주문하기' : '매도 주문하기'}</button>
      {orderButtonGuide && <p className="order-button-guide">{orderButtonGuide}</p>}
      {validationMessage && <p className="order-submit-message error" role="alert">{validationMessage}</p>}
      {capacityWarning && <p className="order-capacity-warning"><AlertTriangle/>{capacityWarning}</p>}
      {submitMessage && <p className="order-submit-message success" role="status">{submitMessage}</p>}
      {ready && accountError && <p className="order-submit-message error" role="alert">계좌 조회 실패: {accountError}</p>}
      <OrderAccessNotice authenticated={authenticated} broker={broker} brokerConfigured={brokerConfigured}/>
      <OrderConfirmDialog draft={draft} stock={stock} broker={broker} pending={pending} error={submitError} onCancel={() => { if (!pending) { setDraft(null); setSubmitError('') } }} onConfirm={submitOrder}/>
    </>
  )
}

function SellAccountPreview({ ready, loading, holding }) {
  const values = [
    holding ? `${Number(holding.averagePrice || 0).toLocaleString('ko-KR')}원` : '0원',
    holding ? `${Number(holding.quantity || 0).toLocaleString('ko-KR')}주` : '0주',
    holding ? `${Number(holding.purchaseAmount || 0).toLocaleString('ko-KR')}원` : '0원',
    holding ? `${Number(holding.evaluationProfit || 0).toLocaleString('ko-KR')}원` : '0원',
  ]
  return (
    <div className="sell-account-preview">
      {['평균 매입단가', '보유수량', '총 매입금액', '평가손익'].map((label, index) => <div key={label}><small>{label}</small><span>{!ready ? 'API 연결 필요' : loading ? '조회 중...' : values[index]}</span></div>)}
    </div>
  )
}

function AutoTrade({ authenticated, brokerConfigured, accountSummary, accountLoading }) {
  const [quantity, setQuantity] = useState('')
  return (
    <>
      <div className="trade-form auto-trade-form">
        <FieldRow label="저장 전략"><select className="trade-input"><option>전략 선택</option></select></FieldRow>
        <FieldRow label="주문가능금액"><div className="trade-input readonly"><span>{!authenticated || !brokerConfigured ? 'API 연결 필요' : accountLoading ? '조회 중...' : accountSummary ? `${Number(accountSummary.orderableAmount || 0).toLocaleString('ko-KR')}원` : '조회 실패'}</span></div></FieldRow>
        <FieldRow label="주문수량"><StepInput value={quantity} onChange={setQuantity} placeholder="수량 입력" unit="주"/></FieldRow>
        <FieldRow label="매수 상한가"><div className="trade-input"><input inputMode="numeric" placeholder="상한가 입력"/></div></FieldRow>
        <FieldRow label="매수 하한가"><div className="trade-input"><input inputMode="numeric" placeholder="하한가 입력"/></div></FieldRow>
      </div>
      <p className="telegram-hint"><i/><span>로그인 후 텔레그램 연동을 사용할 수 있습니다.</span><Info/></p>
      <label className="trade-check"><input type="checkbox"/>매수 상한가와 매수 하한가 둘 다 입력하거나 하나만 입력해도 됩니다.</label>
      <label className="trade-check"><input type="checkbox"/>주문가능금액이 매수 상한가와 매수 하한가 사이에 있고 전략에 도달해야 자동매수가 시작됩니다.</label>
      <button className="order-execute auto" disabled>자동매매 감시 시작</button>
      <p className="order-login-warning"><Info/>자동매매는 아직 주문 감시 서버와 연결되지 않았습니다. 현재는 일반주문만 이용할 수 있습니다.</p>
    </>
  )
}

function NumberSetting({ label, value, onChange, min = 1, max = 500, step = 1 }) {
  return <label className="indicator-config-field"><span>{label}</span><input type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))}/></label>
}

function ColorSetting({ label, value, onChange }) {
  return <label className="indicator-config-field color"><span>{label}</span><input type="color" value={value} onChange={(event) => onChange(event.target.value)}/></label>
}

function SelectSetting({ label, value, onChange, options }) {
  return <label className="indicator-config-field indicator-select-field"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
}

function IndicatorHelpModal({ item, onClose }) {
  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  if (!item) return null
  const titleId = `indicator-help-${item.id}`
  return createPortal(
    <div className="indicator-help-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="indicator-help-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="indicator-help-modal-header">
          <h2 id={titleId}>{item.name}</h2>
          <button type="button" onClick={onClose} aria-label="설명 닫기"><X/></button>
        </header>
        <div className="indicator-help-modal-body">
          <section><h3>개요</h3><p>{item.help.overview}</p></section>
          <section><h3>입력값</h3><ul>{item.help.inputs.map((input) => <li key={input}>{input}</li>)}</ul></section>
          <section><h3>차트에서 보는 법</h3><p>{item.help.reading}</p></section>
          <section><h3>자동매매 해석</h3><p>{item.help.automation}</p></section>
          <section><h3>주의할 점</h3><p>{item.help.caution}</p></section>
          <p className="indicator-help-notice">지표 설명은 기능 이해를 위한 참고 정보이며 투자 수익을 보장하지 않습니다.</p>
        </div>
      </section>
    </div>,
    document.body,
  )
}

function IndicatorConfigCard({ config, onOpenHelp, onChange, onRemove }) {
  const item = INDICATOR_CATALOG.find((indicator) => indicator.id === config.id)
  const update = (key, value) => onChange(config.id, { [key]: value })
  return (
    <article className="indicator-config-card">
      <div className="indicator-config-title"><strong>{item?.name}</strong><button className="indicator-help" onClick={() => onOpenHelp(config.id)} aria-label={`${item?.name} 상세 설명 열기`}>!</button><button className="indicator-remove" onClick={() => onRemove(config.id)} aria-label={`${item?.name} 삭제`}><X/></button></div>
      <div className="indicator-config-grid">
        {config.id === 'ma' && <><SelectSetting label="종류" value={config.type || 'SMA'} options={['SMA', 'EMA']} onChange={(value) => update('type', value)}/><span className="indicator-grid-spacer"/><NumberSetting label="단기 기간" value={config.shortPeriod ?? config.period ?? 5} max={Math.max(1, Number(config.longPeriod || 20) - 1)} onChange={(value) => update('shortPeriod', Math.min(value, Number(config.longPeriod || 20) - 1))}/><ColorSetting label="단기선 색상" value={config.shortColor || config.color || '#f4c542'} onChange={(value) => update('shortColor', value)}/><NumberSetting label="장기 기간" value={config.longPeriod ?? 20} min={Number(config.shortPeriod ?? config.period ?? 5) + 1} onChange={(value) => update('longPeriod', Math.max(value, Number(config.shortPeriod ?? config.period ?? 5) + 1))}/><ColorSetting label="장기선 색상" value={config.longColor || '#4b86ff'} onChange={(value) => update('longColor', value)}/></>}
        {config.id === 'bollinger' && <><NumberSetting label="기간" value={config.period} onChange={(value) => update('period', value)}/><NumberSetting label="표준편차" value={config.multiplier} step={0.1} max={10} onChange={(value) => update('multiplier', value)}/><ColorSetting label="상단선 색상" value={config.upperColor} onChange={(value) => update('upperColor', value)}/><ColorSetting label="중심선 색상" value={config.middleColor} onChange={(value) => update('middleColor', value)}/><ColorSetting label="하단선 색상" value={config.lowerColor} onChange={(value) => update('lowerColor', value)}/></>}
        {config.id === 'volume-ma' && <><NumberSetting label="기간" value={config.period} onChange={(value) => update('period', value)}/><ColorSetting label="거래량 MA 색상" value={config.color} onChange={(value) => update('color', value)}/></>}
        {config.id === 'rsi' && <><NumberSetting label="기간" value={config.period} onChange={(value) => update('period', value)}/><NumberSetting label="하단값" value={config.lower} min={0} max={100} onChange={(value) => update('lower', value)}/><NumberSetting label="상단값" value={config.upper} min={0} max={100} onChange={(value) => update('upper', value)}/><ColorSetting label="RSI선 색상" value={config.color} onChange={(value) => update('color', value)}/><ColorSetting label="상단선 색상" value={config.upperColor} onChange={(value) => update('upperColor', value)}/><ColorSetting label="하단선 색상" value={config.lowerColor} onChange={(value) => update('lowerColor', value)}/></>}
        {config.id === 'macd' && <><NumberSetting label="단기 기간" value={config.fast} onChange={(value) => update('fast', value)}/><NumberSetting label="장기 기간" value={config.slow} onChange={(value) => update('slow', value)}/><NumberSetting label="시그널 기간" value={config.signal} onChange={(value) => update('signal', value)}/><ColorSetting label="MACD선 색상" value={config.macdColor} onChange={(value) => update('macdColor', value)}/><ColorSetting label="시그널선 색상" value={config.signalColor} onChange={(value) => update('signalColor', value)}/><ColorSetting label="상승 색상" value={config.positiveColor} onChange={(value) => update('positiveColor', value)}/><ColorSetting label="하락 색상" value={config.negativeColor} onChange={(value) => update('negativeColor', value)}/></>}
      </div>
    </article>
  )
}

function IndicatorSettings({ indicatorConfigs, strategyName, onStrategyNameChange, onAddIndicator, onUpdateIndicator, onRemoveIndicator, onResetIndicators, onDeleteIndicators }) {
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [helpIndicatorId, setHelpIndicatorId] = useState(null)
  const [actionMessage, setActionMessage] = useState('')
  const searchRef = useRef(null)
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return INDICATOR_CATALOG.filter((item) => !keyword || `${item.name} ${item.shortName}`.toLowerCase().includes(keyword))
  }, [query])
  const addFirstResult = () => {
    const candidate = filtered.find((item) => !indicatorConfigs.some((config) => config.id === item.id))
    if (candidate) {
      onAddIndicator(candidate.id)
      setQuery('')
      setSearchOpen(false)
    }
  }

  useEffect(() => {
    const closeOnOutsideClick = (event) => {
      if (!searchRef.current?.contains(event.target)) setSearchOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    return () => document.removeEventListener('mousedown', closeOnOutsideClick)
  }, [])

  return (
    <div className="indicator-settings">
      <FieldRow label="지표 설정"><select className="trade-input accent"><option>저장한 전략 불러오기</option></select></FieldRow>
      <hr/>
      <label className="strategy-name"><span>전략 이름</span><input className="trade-input" value={strategyName} onChange={(event) => onStrategyNameChange(event.target.value)} placeholder="전략 이름을 입력하세요"/><small>Supabase 연결 후 전략 목록을 불러옵니다.</small></label>
      <div className="indicator-search-wrap" ref={searchRef}>
        <div className="indicator-search"><div className="trade-input"><Search/><input role="combobox" aria-expanded={searchOpen} value={query} onFocus={() => setSearchOpen(true)} onClick={() => setSearchOpen(true)} onChange={(event) => { setQuery(event.target.value); setSearchOpen(true) }} onKeyDown={(event) => { if (event.key === 'Enter') addFirstResult(); if (event.key === 'Escape') setSearchOpen(false) }} placeholder="보조지표 검색"/></div><button onClick={addFirstResult} disabled={!filtered.some((item) => !indicatorConfigs.some((config) => config.id === item.id))}>추가</button></div>
        {searchOpen && <div className="indicator-catalog-popover">
          <div className="indicator-catalog-list">
            {filtered.map((item) => {
              const added = indicatorConfigs.some((config) => config.id === item.id)
              return <button className={added ? 'added' : ''} onClick={() => { added ? onRemoveIndicator(item.id) : onAddIndicator(item.id); setQuery(''); setSearchOpen(false) }} key={item.id}><span><strong>{item.name}</strong><small>{item.shortName}</small></span><b>{added ? '추가됨' : '추가'}</b></button>
            })}
            {filtered.length === 0 && <div className="indicator-no-result">검색 결과가 없습니다.</div>}
          </div>
        </div>}
      </div>
      <div className="indicator-config-list">
        {indicatorConfigs.map((config) => <IndicatorConfigCard key={config.id} config={config} onOpenHelp={setHelpIndicatorId} onChange={onUpdateIndicator} onRemove={onRemoveIndicator}/>) }
        {indicatorConfigs.length === 0 && <div className="indicator-empty">보조지표를 검색해서 추가하세요.</div>}
      </div>
      <div className="strategy-actions-area">
        {actionMessage && <p className="strategy-action-message">{actionMessage}</p>}
        <div className="strategy-actions"><button onClick={() => { onResetIndicators(); setActionMessage('지표 설정을 기본값으로 초기화했습니다.') }} disabled={indicatorConfigs.length === 0}>초기화</button><button onClick={() => { onDeleteIndicators(); setActionMessage('현재 지표 조합을 삭제했습니다.') }} disabled={indicatorConfigs.length === 0}>삭제</button><button className="save" onClick={() => setActionMessage(strategyName.trim() ? '로그인 후 이용할 수 있습니다.' : '전략 이름을 입력해주세요.')}>저장</button></div>
      </div>
      {helpIndicatorId && <IndicatorHelpModal item={INDICATOR_CATALOG.find((item) => item.id === helpIndicatorId)} onClose={() => setHelpIndicatorId(null)}/>} 
    </div>
  )
}

export default function OrderEntryPanel({ stock, authenticated = false, integrationStatus = {}, broker = 'kiwoom', onBrokerChange, accountSummary = null, accountLoading = false, accountError = '', onAccountRefresh, indicatorConfigs = [], strategyName = '', onStrategyNameChange, onAddIndicator, onUpdateIndicator, onRemoveIndicator, onResetIndicators, onDeleteIndicators }) {
  const [mainTab, setMainTab] = useState('order')
  const [mode, setMode] = useState('general')
  const brokerConfigured = Boolean(broker === 'toss' ? integrationStatus.tossConfigured : integrationStatus.kiwoomConfigured)
  return (
    <section className="atlas-order-entry" aria-label="주식 주문 입력">
      <div className="order-main-tabs"><button className={mainTab === 'order' ? 'active' : ''} onClick={() => setMainTab('order')}>주문</button><button className={mainTab === 'indicator' ? 'active' : ''} onClick={() => setMainTab('indicator')}>지표 설정</button></div>
      <div className="broker-select-tabs" aria-label="주문 증권사 선택"><button className={broker === 'kiwoom' ? 'active kiwoom' : ''} onClick={() => onBrokerChange?.('kiwoom')}><span>키움증권</span><small>{integrationStatus.kiwoomConfigured ? '내 API' : '차트 전용'}</small></button><button className={broker === 'toss' ? 'active toss' : ''} onClick={() => onBrokerChange?.('toss')}><span>토스증권</span><small>{integrationStatus.tossConfigured ? '내 API' : '차트 전용'}</small></button></div>
      {mainTab === 'indicator' ? <IndicatorSettings indicatorConfigs={indicatorConfigs} strategyName={strategyName} onStrategyNameChange={onStrategyNameChange} onAddIndicator={onAddIndicator} onUpdateIndicator={onUpdateIndicator} onRemoveIndicator={onRemoveIndicator} onResetIndicators={onResetIndicators} onDeleteIndicators={onDeleteIndicators}/> : <>
        <div className="order-mode-tabs"><button className={mode === 'general' ? 'active' : ''} onClick={() => setMode('general')}>일반주문</button><button className={mode === 'auto' ? 'active' : ''} onClick={() => setMode('auto')}>자동매매</button></div>
        {mode === 'general' ? <GeneralOrder stock={stock} authenticated={authenticated} broker={broker} brokerConfigured={brokerConfigured} accountSummary={accountSummary} accountLoading={accountLoading} accountError={accountError} onAccountRefresh={onAccountRefresh}/> : <AutoTrade authenticated={authenticated} brokerConfigured={brokerConfigured} accountSummary={accountSummary} accountLoading={accountLoading}/>}
      </>}
    </section>
  )
}
