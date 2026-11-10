import { useEffect, useRef, useState } from 'react'
import { Link2 } from 'lucide-react'
import { kakaoConnectionRequest, kakaoLaunchUrl } from '../services/accountSettingsApi'
import './KakaoConnectionSection.css'

const labels = {
  disconnected: '연결 안 됨',
  connected: '연결됨',
  reconnect: '다시 연결 필요',
  unavailable: '일시적으로 연결 확인 불가',
  unlinking: '연결 해제 미완료',
}
const outcomes = {
  canceled: '카카오 인증을 취소했습니다.',
  expired: '연결 요청이 만료되었습니다. 다시 시작해 주세요.',
  conflict: '다른 ATLAS 회원에 연결된 카카오 계정입니다.',
  oauth_failed: '카카오 인증을 완료하지 못했습니다. 다시 시도해 주세요.',
  session_changed: 'ATLAS 로그인 세션이 변경되었습니다. 다시 시작해 주세요.',
  cleanup_pending: '이전 계정의 연결 해제를 먼저 마쳐 주세요.',
  replacement_required: '이미 카카오 계정이 연결되어 있습니다.',
  connection_required: '먼저 카카오 계정을 연결해 주세요.',
  identity_mismatch: '현재 연결된 카카오 계정으로 메시지 전송에 동의해 주세요.',
  consent_required: '카카오톡 메시지 전송에 동의해야 합니다.',
}
const dateTime = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul',
})
const genericError = '일시적으로 카카오 연결을 확인할 수 없습니다.'
const cancel = (flow, userId) => {
  if (flow.requestId) void kakaoConnectionRequest('cancel', userId, {
    body: { requestId: flow.requestId, proof: flow.proof },
  }).catch(() => {})
}
const dispose = (flow) => {
  flow.controller.abort()
  clearTimeout(flow.timer)
  try { flow.popup?.close() } catch { /* The provider may have detached the window. */ }
}

export default function KakaoConnectionSection({ userId }) {
  const [view, setView] = useState(null)
  const [working, setWorking] = useState('')
  const [notice, setNotice] = useState('')
  const active = useRef(null)
  const focus = useRef(null)

  useEffect(() => {
    const controller = new AbortController()
    kakaoConnectionRequest('', userId, { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) setView(value)
    }).catch(() => {
      if (!controller.signal.aborted) setView({ status: 'unavailable' })
    })
    return () => {
      controller.abort()
      if (!active.current) return
      const current = active.current
      active.current = null
      dispose(current)
      cancel(current, userId)
    }
  }, [userId])

  function end(flow, value, message, shouldCancel = false) {
    if (active.current !== flow) return
    active.current = null
    dispose(flow)
    if (shouldCancel) cancel(flow, userId)
    if (value) setView(value)
    setNotice(message)
    setWorking('')
    if (flow.popup) focus.current?.focus()
  }

  function unavailable(flow) {
    end(flow, { ...view, status: 'unavailable' }, genericError, Boolean(flow.popup))
  }

  async function run(action, body) {
    if (active.current) return
    const flow = { controller: new AbortController() }
    active.current = flow
    setWorking(action)
    setNotice('')
    try {
      const value = await kakaoConnectionRequest(action, userId, { body, signal: flow.controller.signal })
      end(flow, value, outcomes[value.outcome] ?? '')
    } catch {
      unavailable(flow)
    }
  }

  async function connect(replace, message = false) {
    if (active.current) return
    if (replace && !window.confirm('다른 카카오 계정으로 인증하면 현재 연결을 교체합니다. 계속할까요?')) return
    let popup
    try { popup = window.open('about:blank', '_blank', 'popup,width=500,height=700') } catch { /* handled below */ }
    if (!popup) {
      setNotice('인증 창을 열지 못했습니다. 이 사이트의 팝업을 허용한 뒤 다시 시도해 주세요.')
      return
    }
    const flow = { popup, controller: new AbortController(), started: Date.now() }
    active.current = flow
    setWorking('connect')
    setNotice('')
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(32))
      flow.proof = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(flow.proof))
      const proofHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
      const payload = await kakaoConnectionRequest('start', userId, {
        body: { proofHash, replace, ...(message ? { purpose: 'message' } : {}) }, signal: flow.controller.signal,
      })
      if (active.current !== flow) return
      if (payload.outcome || payload.available === false) {
        end(flow, payload.status ? payload : null, outcomes[payload.outcome] ?? genericError)
        return
      }
      flow.requestId = payload.requestId
      const url = kakaoLaunchUrl(payload.launchUrl)
      flow.origin = url.origin
      popup.location.replace(url.href)
      const poll = async () => {
        if (active.current !== flow || flow.polling) return
        clearTimeout(flow.timer)
        if (Date.now() - flow.started >= 300_000) {
          end(flow, null, outcomes.expired, true)
          return
        }
        flow.polling = true
        try {
          const value = await kakaoConnectionRequest('finish', userId, {
            body: { requestId: flow.requestId, proof: flow.proof }, signal: flow.controller.signal,
          })
          if (active.current !== flow) return
          if (value.outcome === 'pending') flow.timer = setTimeout(poll, 3000)
          else end(flow, value, value.outcome === 'connected'
            ? (message ? '카카오톡 메시지 전송 동의를 확인했습니다.' : '카카오 계정 연결을 완료했습니다.')
            : outcomes[value.outcome] ?? genericError)
        } catch {
          unavailable(flow)
        } finally {
          flow.polling = false
        }
      }
      flow.poll = poll
      flow.timer = setTimeout(poll, 3000)
    } catch {
      unavailable(flow)
    }
  }

  useEffect(() => {
    const receive = (event) => {
      const flow = active.current
      if (flow?.poll && event.origin === flow.origin && event.source === flow.popup
        && event.data?.type === 'atlas:kakao' && event.data.requestId === flow.requestId) void flow.poll()
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])

  const status = view?.status
  const knownLink = Boolean(view?.maskedId)
  const disabled = Boolean(working)
  const time = (value) => Number.isFinite(Date.parse(value)) ? dateTime.format(new Date(value)) : null
  const confirmUnlink = () => {
    if (window.confirm('카카오 계정 연결을 해제할까요? ATLAS 로그인은 유지됩니다.')) void run('unlink', { pendingOnly: false })
  }

  return (
    <section className="account-section kakao-connection" aria-label="카카오톡 연결">
      <div className="account-section-head"><div><Link2 aria-hidden="true"/><span><strong>카카오톡 연결</strong><small>카카오 계정을 연결하고 메시지 전송 동의를 관리합니다.</small></span></div></div>
      <p ref={focus} tabIndex={-1} className="kakao-status" role="status">
        {working === 'connect' ? '연결 중' : working === 'check' || !view ? '연결 확인 중' : working === 'unlink' ? '연결 해제 중' : labels[status] ?? genericError}
        {knownLink && <span>계정 {view.maskedId}{time(view.linkedAt) && ` · 연결 ${time(view.linkedAt)}`}</span>}
        {status === 'connected' && time(view.verifiedAt) && <span>최근 확인 {time(view.verifiedAt)} (한국 시간)</span>}
      </p>
      {view?.available === false && <p className="kakao-note">카카오 계정 연결을 준비 중입니다.</p>}
      {view?.cleanupPending && <p className="kakao-note">ATLAS에서 해당 연결의 사용을 중지했습니다. 카카오에서도 연결이 해제되도록 다시 시도해 주세요.</p>}
      {status === 'connected' && view.messageConsentAvailable && <p className="kakao-note">
        {view.messageAuthorized ? '카카오톡 메시지 전송 동의 완료' : '카카오톡 메시지 전송 동의 필요'}
      </p>}
      {notice && <p className="kakao-note" role="status">{notice}</p>}
      <div className="kakao-actions">
        {working === 'connect' ? <button type="button" onClick={() => end(active.current, null, outcomes.canceled, true)}>인증 취소</button>
          : view && view.available !== false && <>
            {status === 'disconnected' && <button type="button" disabled={disabled} onClick={() => connect(false)}>카카오 계정 연결</button>}
            {['connected', 'unavailable'].includes(status) && <button type="button" disabled={disabled} onClick={() => run('check')}>연결 확인</button>}
            {status === 'reconnect' && <button type="button" disabled={disabled || view.cleanupPending} onClick={() => connect(true)}>다시 연결</button>}
            {status === 'connected' && <button type="button" disabled={disabled || view.cleanupPending} onClick={() => connect(true)}>계정 변경</button>}
            {status === 'connected' && view.messageConsentAvailable && !view.messageAuthorized &&
              <button type="button" disabled={disabled || view.cleanupPending} onClick={() => connect(false, true)}>메시지 전송 동의</button>}
            {knownLink && <button type="button" disabled={disabled} onClick={confirmUnlink}>연결 해제</button>}
            {view.cleanupPending && <button type="button" disabled={disabled} onClick={() => run('unlink', { pendingOnly: true })}>연결 해제 재시도</button>}
          </>}
      </div>
    </section>
  )
}
