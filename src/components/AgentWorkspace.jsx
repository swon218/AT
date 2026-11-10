import { useEffect, useRef, useState } from 'react'
import { ArrowUp, ArrowUpRight, Bot, Check, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Search, Sparkles, Trash2, X } from 'lucide-react'
import robotImage from '../assets/atlas-agent.png'
import { MAX_QUESTION_LENGTH, ROBOT_SIZE, robotCoordinates, robotPosition } from '../utils/agentWorkspace'
import './AgentWorkspace.css'
import { safeAgentLink } from '../services/agentApi'
import { importQuery } from '../utils/screener'
import { alertCondition, alertFrequencyLabel } from '../../shared/alertRules'
import { WATCHLIST_LIMIT_MESSAGE } from '../../shared/watchlist'

const suggestions = [
  { label: '조건으로 종목 찾기', text: '일봉 RSI 30 이하인 종목을 찾아줘', icon: Search },
  { label: '종목 뉴스 살펴보기', text: '삼성전자 밤사이 뉴스는 어때?', icon: MessageSquare },
  { label: '여러 종목 비교하기', text: '삼성전자와 SK하이닉스의 최근 이슈를 비교해줘', icon: Sparkles },
]
const dateLabel = value => new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' }).format(new Date(value))
const timeLabel = value => new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
const alertToolResults = {
  watchlist_confirmation: '미등록 종목과 요청 조건 확인', draft: '알림 초안 생성 가능', symbol_candidates: '종목 선택 필요',
  symbol_not_found: '일치 종목 없음', symbol_catalog_unavailable: '종목 목록 조회 불가', watchlist_required: '관심종목 확인 필요',
  invalid: '알림 조건 확인 필요', ambiguous: '종목 확인 필요', unsupported: '지원 조건 확인 필요', unavailable: '로그인 필요',
}
const validationMessages = {
  alert_proposal_required: '알림 확인 카드를 만들기 위해 조건을 다시 확인합니다.',
  unsupported_claims: '확인 질문이나 자료 부족 답변에 사실 주장 또는 판단이 포함됐습니다.',
  unsupported_current_facts: '답변에 근거가 없는 시세나 수치가 포함됐습니다.',
  unsafe_investment_instruction: '답변에 직접적인 매매 지시나 수익 보장이 포함됐습니다.',
  fresh_evidence_required: '최신 정보를 뒷받침할 새 조회 결과가 필요합니다.',
  evidence_required: '사실 주장에 연결된 근거가 없습니다.',
  invalid_evidence_id: '조회 결과에서 해당 근거를 찾지 못했습니다.',
  excerpt_mismatch: '인용한 내용이 조회 결과와 일치하지 않습니다.',
  rsi_value_mismatch: '지표 인용이 조회한 값과 일치하지 않습니다.',
  unverified_company_relevance: '해당 종목과의 직접적인 관련성을 확인하지 못했습니다.',
  unsupported_number: '인용한 근거에서 해당 수치를 확인하지 못했습니다.',
  claim_content_mismatch: '답변의 설명이 인용한 자료와 일치하지 않습니다.',
  uncited_summary_numbers: '답변 요약에 근거가 연결되지 않은 수치가 있습니다.',
  invalid_final_schema: '답변 형식을 확인하지 못했습니다.',
}

function ExecutionStep({ step }) {
  const code = step.result?.code
  if (step.kind === 'validation' && step.name === 'final' && step.status === 'error') {
    const known = Object.hasOwn(validationMessages, code)
    return <p>{step.seq}. 답변 검증 실패 {known && <>· <code>{code}</code></>} · {known ? validationMessages[code] : '답변을 검증하지 못했습니다.'}</p>
  }
  const result = step.name === 'propose_alert' && alertToolResults[code]
    ? alertToolResults[code] : step.result?.count !== undefined ? `${step.result.count}건` : ''
  return <p>{step.seq}. {step.name} · {step.status} · {step.elapsed_ms}ms {result && `· ${result}`}</p>
}

function AgentStatus({ agent }) {
  const state = agent?.status?.provider?.state
  const labels = { api_key_missing: 'API 키 미설정', configured: '키 설정됨 · 호출 미확인', recent_success: '최근 호출 성공', connection_failed: 'AI 서버 연결 실패', authentication_error: '키 인증 오류', permission_error: '모델 권한 오류', billing_error: '결제 오류', billing_or_rate_limit: '결제/요청 한도 오류' }
  return <span className="agent-status"><i/>{agent?.status?.enabled === false ? 'AI 신규 요청 중지됨' : agent?.busy ? '조사 실행 중' : labels[state] || 'AI 설정 확인 중'}</span>
}

function Composer({ agent, compact = false }) {
  const input = useRef(null)
  useEffect(() => { input.current?.focus({ preventScroll: true }) }, [agent.active.id])
  const submit = event => { event?.preventDefault(); agent.submit(); input.current?.focus({ preventScroll: true }) }
  return <div className={`agent-compose-area${compact ? ' compact' : ''}`}>
    {agent.error && <p className="agent-feedback" role="status">{agent.error}</p>}
    <form className="agent-composer" onSubmit={submit}>
      <label className="agent-sr-only" htmlFor={compact ? 'agent-mini-input' : 'agent-main-input'}>에이전트에게 남길 질문</label>
      <textarea ref={input} id={compact ? 'agent-mini-input' : 'agent-main-input'} rows={compact ? 2 : 3} maxLength={MAX_QUESTION_LENGTH}
        value={agent.active.draft} onChange={event => agent.setDraft(event.target.value)}
        placeholder="궁금한 종목이나 조건을 적어보세요"
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); submit() }
        }}/>
      <div className="agent-composer-bottom"><span>{agent.active.draft.length.toLocaleString()} / 6,000</span>
        <button type="submit" className="agent-send" disabled={!agent.ready || agent.busy || !agent.active.draft.trim()} aria-label="질문 보내기"><ArrowUp size={17}/><span>{agent.busy ? '처리 중' : '보내기'}</span></button>
      </div>
    </form>
    <p className="agent-compose-note">{compact ? '서버에 대화 저장 · 조회 전용 AI' : 'Enter로 전송 · Shift+Enter로 줄바꿈 · 로그인 대화는 계정별 서버 저장 · 비로그인 한국시간 하루 2회'}</p>
  </div>
}

function WatchlistConfirmation({ agent, message, latest }) {
  const { watchlistConfirmation: card, alertDraft } = message.answer
  const feedback = agent.confirmations?.[message.request_id]
  const expired = card.status === 'pending' && Date.parse(card.expiresAt) <= Date.now()
  const outdated = latest !== message.request_id || (agent.confirmationRevision !== card.baseRevision
    && agent.confirmationRevision !== alertDraft?.revision)
  const status = expired ? 'expired' : card.status
  const added = card.addition === 'already_saved' ? `${card.name}는 이미 관심종목에 등록되어 있습니다.` : `${card.name}를 관심종목에 추가했습니다.`
  const labels = {
    pending: `${card.name}를 관심종목에 추가할까요?`,
    declined: `${card.name}를 관심종목에 추가하지 않았습니다. 이번 알림 설정 요청을 종료합니다.`,
    expired: '관심종목 추가 요청이 만료되었습니다.', superseded: '새 질문이 등록되어 이 알림 요청은 종료되었습니다.',
    limit: WATCHLIST_LIMIT_MESSAGE, added, ready: `${added} 알림 조건을 확인한 뒤 저장해 주세요.`,
  }
  const choice = decision => agent.respondToWatchlist(message, decision)
  return <section className="agent-watchlist-confirmation" aria-label={`${card.name} 관심종목 추가 확인`}>
    <p role="status">{labels[status]}</p>
    <small>{card.name} ({card.condition.code}) · {alertCondition(card.condition.kind, card.condition.threshold)} · {alertFrequencyLabel(card.condition.frequency)} · {card.condition.expires_on}까지</small>
    {status === 'pending' && <p>관심종목에 추가한 뒤 미저장 알림 초안을 열 수 있습니다.</p>}
    {outdated && ['pending', 'added'].includes(status) && <p>대화나 조건이 바뀌었습니다. 최신 요청을 확인해 주세요.</p>}
    {status === 'added' && <p>{feedback?.error ? '알림 초안 생성에 실패했습니다.' : '알림 초안 생성이 남아 있습니다.'}</p>}
    {feedback?.error && ['pending', 'added', 'ready'].includes(status) && <p role="alert">{feedback.error}</p>}
    {status === 'pending' && <div className="agent-watchlist-actions">
      <button type="button" className="agent-expand-result" disabled={feedback?.busy || outdated} onClick={() => choice('yes')}>1번 예</button>
      <button type="button" className="agent-expand-result" disabled={feedback?.busy} onClick={() => choice('no')}>2번 아니요</button>
    </div>}
    {['added', 'ready'].includes(status) && !outdated && <button type="button" className="agent-expand-result" disabled={feedback?.busy}
      onClick={() => choice('draft')}>{status === 'ready' ? '알림 초안 열기' : '알림 초안 다시 시도'}</button>}
  </section>
}

const indicatorValue = (value, name, unit) => {
  if (!Number.isFinite(value)) return '—'
  if (name === 'supertrend_direction' || name === 'supertrend_flip') return value === 1 ? '상승' : value === -1 ? '하락' : '전환 없음'
  return `${value.toLocaleString('ko-KR', { maximumFractionDigits: 4 })}${unit || ''}`
}

function IndicatorResult({ result }) {
  const { coverage, items } = result
  return <details className="agent-execution agent-indicator-result" open>
    <summary>{coverage.name} · 확정 일봉 지표 · {coverage.as_of}</summary>
    <div className="screen-table-wrap"><table className="screen-table">
      <thead><tr><th>지표·설정</th><th>기준일</th><th>이전 봉</th></tr></thead>
      <tbody>{items.map(item => <tr key={item.id}><th scope="row">{item.label}</th><td>{indicatorValue(item.value, item.name, item.unit)}</td><td>{indicatorValue(item.previous, item.name, item.unit)}</td></tr>)}
      {coverage.unavailable.map(item => <tr key={item.metric}><th scope="row">{item.label}</th><td colSpan={2}>{item.reason}</td></tr>)}</tbody>
    </table></div>
    <p>실험실 확정 일봉{coverage.previous_date ? ` · 이전 봉 ${coverage.previous_date}` : ''}{coverage.seed_date ? ` · 계산 이력 시작 ${coverage.seed_date}` : ''}</p>
  </details>
}

function Conversation({ agent, compact = false, onExpand }) {
  const bottom = useRef(null)
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }) }, [agent.active.id, agent.active.messages.length])
  const messages = agent.active.messages
  const latest = messages.findLast(message => message.role === 'user')?.request_id
  return <div className={`agent-conversation${compact ? ' compact' : ''}`}>
    {!messages.length ? <div className="agent-empty">
      <img className="agent-hero-robot" src={robotImage} alt="작은 지구를 든 ATLAS 로봇"/>
      <span className="agent-eyebrow">YOUR MARKET COMPANION</span>
      <h2>{compact ? '무엇이 궁금하세요?' : 'ATLAS와 함께 살펴볼까요?'}</h2>
      <p>종목과 시장에 관한 질문을 남겨보세요.<br/>필요한 자료를 조회하고 근거와 한계를 설명합니다.</p>
      <div className="agent-suggestions">{suggestions.slice(0, compact ? 2 : 3).map(({ label, text, icon: Icon }) =>
        <button type="button" key={label} onClick={() => agent.setDraft(text)}><Icon size={17}/><span><strong>{label}</strong><small>{text}</small></span><ArrowUpRight size={15}/></button>
      )}</div>
    </div> : <div className="agent-message-list" role="log" aria-label="대화 내용" aria-live="polite" aria-relevant="additions">
      {agent.hasMore && <button type="button" className="agent-expand-result" onClick={agent.loadMore}>이전 메시지 더 보기</button>}
      {messages.map(message => <div className="agent-message" key={message.id} id={`agent-message-${compact ? 'mini' : 'main'}-${message.id}`}>
        <div className="agent-message-meta"><span>{message.role === 'assistant' ? 'ATLAS AI' : '나'}</span><time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time></div>
        <div className={message.role === 'assistant' ? 'agent-assistant-message' : 'agent-user-message'}>{message.content.split('\n').map((line, i) => <p key={i}>{line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, j) => part.startsWith('**') ? <strong key={j}>{part.slice(2, -2)}</strong> : part.startsWith('`') ? <code key={j}>{part.slice(1, -1)}</code> : part)}</p>)}</div>
        {message.answer?.watchlistConfirmation && <WatchlistConfirmation agent={agent} message={message} latest={latest}/>}
        {message.answer?.result_sets?.filter(set => set.coverage?.kind === 'indicator' && (set.items.length || set.coverage.unavailable?.length)).map(set => <IndicatorResult key={set.id} result={set}/>)}
        {!!message.answer?.sources?.length && <ul className="agent-sources">{message.answer.sources.map(source => <li key={source.id}>{safeAgentLink(source.url) ? <a href={safeAgentLink(source.url)} target="_blank" rel="noopener noreferrer">{source.title || source.id}</a> : <span>{source.excerpt || source.id}</span>}<small>{source.source} · {source.published_at || source.as_of} · {source.scope === 'title_and_snippet' ? '제목·요약' : '확정 일봉'}</small></li>)}</ul>}
        {agent.openScreen && message.answer?.result_sets?.filter(set => set.coverage?.kind === 'screen' && importQuery(set.query)).map(set => <button type="button" className="agent-expand-result" key={set.id} onClick={() => agent.openScreen(set.query)}>조건검색에서 조건 열기 · 최신 데이터로 다시 조회<ArrowUpRight size={14}/></button>)}
        <div className="agent-message-state"><Check size={12}/><span>{message.role === 'assistant' ? `${agent.active.requests?.find(r => r.id === message.request_id)?.status === 'partial' ? '부분 완료' : '완료'} · ${message.answer?.as_of || ''}` : '질문 저장됨'}</span></div>
      </div>)}
      {compact && <button type="button" className="agent-expand-result" onClick={onExpand}>이 대화를 넓게 보기<ArrowUpRight size={15}/></button>}
    </div>}
    {agent.busy && <div className="agent-connection-note" role="status"><Bot size={20}/><p>{agent.steps?.at(-1)?.kind === 'tool' ? ({ screen_stocks: '공통 일봉 조건검색 중', screen_rsi: 'RSI 조건 확인 중', get_stock_news: '뉴스 조회 중', resolve_symbol: '종목 확인 중', get_news_details: '확보 기사 확인 중', get_market_context: '거래일 기준 확인 중' }[agent.steps.at(-1).name] || '조회 결과 확인 중') : agent.steps?.length ? '모델 분석 중' : '요청 처리 대기 중'}</p></div>}
    {!!agent.steps?.length && <details className="agent-execution"><summary>실행 기록 {agent.steps.length}개</summary>{agent.steps.map(step => <ExecutionStep key={step.seq} step={step}/>)}</details>}
    <div ref={bottom}/>
  </div>
}

export default function AgentWorkspace({ agent, onOpenMini }) {
  const [historyOpen, setHistoryOpen] = useState(() => window.innerWidth > 1050)
  const [query, setQuery] = useState('')
  const [deleteId, setDeleteId] = useState(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [renaming, setRenaming] = useState(false)
  useEffect(() => { setRenaming(false); setRenameTitle(agent.active.title) }, [agent.active.id])
  useEffect(() => {
    const resize = () => { if (window.innerWidth <= 1050) setHistoryOpen(false) }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const conversations = [...agent.data.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .filter(conversation => `${conversation.title} ${conversation.messages.map(message => message.content).join(' ')}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const select = id => { agent.select(id); setDeleteId(null); if (window.innerWidth <= 1050) setHistoryOpen(false) }
  return <section className={`agent-workspace${historyOpen ? ' history-open' : ''}`} aria-label="AI 에이전트 대화방">
    {historyOpen && <button type="button" className="agent-history-backdrop" aria-label="대화 목록 닫기" onClick={() => setHistoryOpen(false)}/>}
    {historyOpen && <aside className="agent-history" aria-label="에이전트 대화 목록">
      <div className="agent-history-title"><span><Bot size={20}/>대화 기록</span><button type="button" className="agent-icon-button" aria-label="대화 목록 접기" onClick={() => setHistoryOpen(false)}><PanelLeftClose size={18}/></button></div>
      <button type="button" className="agent-new-chat" onClick={() => { if (agent.newConversation()) { setQuery(''); setDeleteId(null); if (window.innerWidth <= 1050) setHistoryOpen(false) } }}><Plus size={17}/>새 대화</button>
      <label className="agent-history-search"><Search size={15}/><input aria-label="대화 검색" value={query} onChange={event => setQuery(event.target.value)} placeholder="대화 검색"/></label>
      <div className="agent-history-list">{conversations.length ? conversations.map(conversation => <div className={`agent-history-item${conversation.id === agent.active.id ? ' selected' : ''}`} key={conversation.id}>
        <button type="button" className="agent-history-select" aria-current={conversation.id === agent.active.id ? 'true' : undefined} onClick={() => select(conversation.id)}><MessageSquare size={15}/><span><strong>{conversation.title}</strong><small>{dateLabel(conversation.updatedAt)} · 질문 {conversation.question_count ?? conversation.messages.filter(m => m.role === 'user').length}개</small></span></button>
        <button type="button" className="agent-delete-chat" aria-label={`${conversation.title} 대화 삭제`} onClick={() => setDeleteId(conversation.id)}><Trash2 size={14}/></button>
        {deleteId === conversation.id && <div className="agent-delete-confirm" role="group" aria-label="대화 삭제 확인"><p>이 대화와 작성 중인 글을 삭제할까요?</p><div><button type="button" onClick={() => setDeleteId(null)}>취소</button><button type="button" onClick={() => { agent.remove(conversation.id); setDeleteId(null) }}>삭제</button></div></div>}
      </div>) : <p className="agent-history-empty">일치하는 대화가 없습니다.</p>}</div>
      <div className="agent-local-note"><span className="agent-local-dot"/>계정별 서버 대화<small>비로그인 대화 기본 7일 보관</small></div>
      {!!agent.legacy?.length && <details className="agent-legacy"><summary>이전 브라우저 기록 ({agent.legacy.length})</summary><small>이전 기록은 업로드하거나 삭제하지 않았습니다. 읽기 전용입니다.</small>{agent.legacy.map(c => <details key={c.id}><summary>{c.title}</summary>{c.messages.map(m => <p key={m.id}>{m.content}</p>)}</details>)}</details>}
    </aside>}
    <div className="agent-main-chat">
      <div className="agent-chat-toolbar">
        <div className="agent-chat-heading">{!historyOpen && <button type="button" className="agent-icon-button" aria-label="대화 목록 펼치기" onClick={() => setHistoryOpen(true)}><PanelLeftOpen size={19}/></button>}<span>{renaming ? <form onSubmit={event => { event.preventDefault(); if (renameTitle.trim()) { agent.rename(renameTitle.trim()); setRenaming(false) } }}><input aria-label="대화 제목" maxLength={80} value={renameTitle} onChange={event => setRenameTitle(event.target.value)}/><button type="submit">저장</button><button type="button" onClick={() => setRenaming(false)}>취소</button></form> : <strong>{agent.active.title} {agent.active.id !== 'new' && <button type="button" className="agent-title-edit" onClick={() => { setRenameTitle(agent.active.title); setRenaming(true) }}>제목 변경</button>}</strong>}<small>ATLAS AI · 조회와 분석을 위한 대화 공간</small></span></div>
        <div className="agent-chat-actions"><label className="agent-robot-toggle"><input type="checkbox" checked={agent.data.ui.robotVisible} onChange={event => agent.setUI({ robotVisible: event.target.checked })}/><span className="agent-toggle-track"/><span>로봇 표시</span></label><button type="button" className="agent-mini-shortcut" onClick={onOpenMini}><ArrowUpRight size={16}/><span>작게 열기</span></button></div>
      </div>
      <div className="agent-status-row"><AgentStatus agent={agent}/><span>자료를 확인하는 조사 담당 AI · 주문 기능 없음</span></div>
      {agent.ready ? <><Conversation agent={agent}/><Composer agent={agent}/></> : <div className="agent-loading" role="status">대화 공간을 불러오는 중입니다.</div>}
    </div>
  </section>
}

function viewportSize() {
  return { width: Math.min(window.visualViewport?.width || window.innerWidth, document.documentElement.clientWidth || window.innerWidth), height: window.visualViewport?.height || window.innerHeight }
}

export function FloatingAgent({ agent, visible, onExpand, context }) {
  const [viewport, setViewport] = useState(viewportSize)
  const [movingPosition, setMovingPosition] = useState(null)
  const [hiddenNotice, setHiddenNotice] = useState(false)
  const drag = useRef(null)
  const launcher = useRef(null)
  useEffect(() => {
    const resize = () => { setViewport(viewportSize()); setMovingPosition(null) }
    window.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('resize', resize)
    return () => { window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize) }
  }, [])
  useEffect(() => {
    if (!hiddenNotice) return
    const timer = window.setTimeout(() => setHiddenNotice(false), 7000)
    return () => window.clearTimeout(timer)
  }, [hiddenNotice])
  useEffect(() => { setMovingPosition(null); setHiddenNotice(false); drag.current = null }, [agent.data.activeId, visible])
  const closeMini = () => { agent.setUI({ miniOpen: false }); launcher.current?.focus({ preventScroll: true }) }
  const position = movingPosition || agent.data.ui.position
  const coordinates = robotCoordinates(position, viewport)
  const width = Math.min(400, viewport.width - 24)
  const leftSpace = coordinates.x - 26
  const rightSpace = viewport.width - coordinates.x - ROBOT_SIZE - 26
  const aboveSpace = Math.max(0, coordinates.y - 26)
  const belowSpace = Math.max(0, viewport.height - coordinates.y - ROBOT_SIZE - 26)
  const vertical = leftSpace < width && rightSpace < width
  // On a short keyboard/landscape viewport, use the header close button and keep the composer clear.
  const overlay = vertical && agent.data.ui.miniOpen && Math.max(aboveSpace, belowSpace) < 260
  let height = Math.min(570, viewport.height - 32)
  let miniLeft = leftSpace >= width ? coordinates.x - width - 14 : coordinates.x + ROBOT_SIZE + 14
  let miniTop = Math.min(Math.max(12, coordinates.y + ROBOT_SIZE - height), Math.max(12, viewport.height - height - 12))
  if (vertical) {
    miniLeft = Math.min(Math.max(12, coordinates.x + ROBOT_SIZE / 2 - width / 2), viewport.width - width - 12)
    if (overlay) { miniTop = 12; height = Math.min(570, viewport.height - 24) }
    else {
      const above = aboveSpace >= belowSpace
      height = Math.min(570, above ? aboveSpace : belowSpace)
      miniTop = above ? coordinates.y - height - 14 : coordinates.y + ROBOT_SIZE + 14
    }
  }
  if (!agent.ready || !visible) return null
  return <>
    {hiddenNotice && !agent.data.ui.robotVisible && <div className="agent-hide-notice" role="status"><span>로봇을 숨겼습니다. AI 에이전트 탭에서 다시 표시할 수 있습니다.</span><button type="button" onClick={() => { agent.setUI({ robotVisible: true }); setHiddenNotice(false) }}>실행 취소</button></div>}
    {agent.data.ui.robotVisible && <>
      {agent.data.ui.miniOpen && <section className="agent-mini-chat" aria-label="AI 에이전트 작은 채팅창" role="region" style={{ left: miniLeft, top: miniTop, width, height }} onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); closeMini() } }}>
        <div className="agent-mini-header"><span className="agent-mini-avatar"><img src={robotImage} alt=""/></span><span><strong>ATLAS AI</strong><AgentStatus agent={agent}/></span><div><button type="button" className="agent-icon-button" aria-label="대화를 AI 에이전트 탭에서 넓게 보기" onClick={onExpand}><ArrowUpRight size={19}/></button><button type="button" className="agent-icon-button" aria-label="작은 채팅창 닫기" onClick={closeMini}><X size={19}/></button></div></div>
        <div className="agent-mini-context"><MessageSquare size={13}/><span>현재 화면: {context}</span><button type="button" aria-label="작은 창에서 새 대화 시작" onClick={agent.newConversation}><Plus size={15}/></button></div>
        <Conversation agent={agent} compact onExpand={onExpand}/><Composer agent={agent} compact/>
      </section>}
      {!overlay && <div className="agent-launcher" style={{ left: coordinates.x, top: coordinates.y }}>
        <button ref={launcher} type="button" className="agent-robot-button" aria-label="AI 에이전트 채팅 열기 또는 접기" aria-expanded={agent.data.ui.miniOpen} title="클릭해서 대화 · 드래그해서 이동 · 방향키로 위치 조정"
          onPointerDown={event => {
            if (event.button !== 0) return
            drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin: coordinates, moved: false }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={event => {
            const gesture = drag.current
            if (!gesture || gesture.pointerId !== event.pointerId) return
            const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y
            if (Math.hypot(dx, dy) > 6) gesture.moved = true
            if (gesture.moved) setMovingPosition(robotPosition({ x: gesture.origin.x + dx, y: gesture.origin.y + dy }, viewport))
          }}
          onPointerUp={event => {
            const gesture = drag.current
            if (!gesture || gesture.pointerId !== event.pointerId) return
            if (gesture.moved) agent.setUI({ position: robotPosition({ x: gesture.origin.x + event.clientX - gesture.x, y: gesture.origin.y + event.clientY - gesture.y }, viewport) })
            gesture.pointerId = null
            setMovingPosition(null)
          }}
          onPointerCancel={() => { drag.current = { moved: true }; setMovingPosition(null) }}
          onClick={() => { if (!drag.current?.moved) agent.setUI({ miniOpen: !agent.data.ui.miniOpen }) }}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') drag.current = null
            const shifts = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }
            if (!shifts[event.key]) return
            event.preventDefault()
            const [x, y] = shifts[event.key]
            agent.setUI({ position: robotPosition({ x: coordinates.x + x, y: coordinates.y + y }, viewport) })
          }}><img src={robotImage} alt="지구를 든 ATLAS 에이전트" draggable="false"/><span className="agent-launcher-label">ATLAS AI</span></button>
        <button type="button" className="agent-hide-robot" aria-label="에이전트 로봇 숨기기" title="로봇 숨기기" onClick={() => { agent.setUI({ robotVisible: false, miniOpen: false }); setHiddenNotice(true) }}><X size={14}/></button>
      </div>}
    </>}
  </>
}
