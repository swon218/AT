import { useEffect, useRef, useState } from 'react'
import { Activity, Eye, EyeOff, LockKeyhole, Mail, X } from 'lucide-react'
import { isSupabaseConfigured, supabase } from '../services/supabaseClient'
import { passwordResetRedirect } from '../services/passwordRecovery'

const authErrorMessage = (error) => {
  const message = error?.message ?? ''
  if (/invalid login credentials/i.test(message)) return '이메일 또는 비밀번호가 올바르지 않습니다.'
  if (/email not confirmed/i.test(message)) return '이메일 인증을 완료한 후 로그인해 주세요.'
  if (/user already registered/i.test(message)) return '이미 가입된 이메일입니다.'
  if (/password should be at least/i.test(message)) return '비밀번호는 6자 이상 입력해 주세요.'
  if (error?.code === 'same_password') return '기존 비밀번호와 다른 새 비밀번호를 입력해 주세요.'
  if (error?.code === 'weak_password') return '비밀번호가 보안 조건에 맞지 않습니다. 더 길고 다양한 문자를 사용해 주세요.'
  if (error?.status === 429 || /rate limit|too many requests|security purposes/i.test(message)) return '요청이 너무 많습니다. 잠시 기다린 후 다시 시도해 주세요.'
  if (error?.code === 'email_address_not_authorized') return '메일 발송이 제한되어 있습니다. 관리자에게 문의해 주세요.'
  if (/session missing|expired|invalid.*token/i.test(message)) return '재설정 링크가 만료되었습니다. 새 링크를 요청해 주세요.'
  return message || '인증 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'
}

export default function AuthModal({ open, onClose, recovery, onRecoveryFinished }) {
  const [selectedMode, setMode] = useState('login')
  const mode = recovery ? 'reset' : selectedMode
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [messageType, setMessageType] = useState('error')
  const inputRef = useRef(null)
  const busy = submitting || recovery?.status === 'checking'

  useEffect(() => {
    if (!open) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0)

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose, busy, mode])

  useEffect(() => {
    setMessage('')
    setMessageType('error')
    setPassword('')
    setConfirmPassword('')
    setShowPassword(false)
  }, [mode, open])

  useEffect(() => {
    if (!open) setMode('login')
  }, [open])

  if (!open) return null

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (busy) return
    setMessage('')
    setMessageType('error')

    if (!isSupabaseConfigured || !supabase) {
      setMessage('Supabase 환경 설정을 확인해 주세요.')
      return
    }
    if ((mode === 'signup' || mode === 'reset') && password !== confirmPassword) {
      setMessage('비밀번호가 서로 일치하지 않습니다.')
      return
    }

    setSubmitting(true)
    try {
      if (mode === 'forgot') {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: passwordResetRedirect(window.location.href),
        })
        if (error) throw error
        setMessageType('success')
        setMessage('가입된 이메일이라면 재설정 링크가 발송됩니다. 받은편지함과 스팸함을 확인해 주세요.')
        return
      }
      if (mode === 'reset') {
        if (recovery.status !== 'ready') return
        const { error } = await supabase.auth.updateUser({ password })
        if (error) throw error
        // Switch to a completion screen so the password cannot be submitted twice.
        setMode('complete')
        onRecoveryFinished()
        setPassword('')
        setConfirmPassword('')
        return
      }
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
        if (error) throw error
        onClose()
        return
      }

      const { data, error } = await supabase.auth.signUp({ email: email.trim(), password })
      if (error) throw error
      if (data.session) {
        onClose()
      } else {
        setMessageType('success')
        setMessage('가입 확인 메일을 보냈습니다. 이메일 인증 후 로그인해 주세요.')
      }
    } catch (error) {
      setMessageType('error')
      setMessage(authErrorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  const changeMode = (nextMode) => {
    if (busy) return
    if (recovery) onRecoveryFinished()
    setMode(nextMode)
    setMessageType('error')
  }

  const headings = {
    login: ['다시 오신 것을 환영합니다', '로그인하고 나만의 투자 환경을 불러오세요.'],
    signup: ['ATLAS 계정 만들기', '계정을 만들고 관심종목과 전략을 저장하세요.'],
    forgot: ['비밀번호 찾기', '가입한 이메일로 비밀번호 재설정 링크를 보내드립니다.'],
    reset: ['새 비밀번호 설정', '새 비밀번호를 입력하고 한 번 더 확인해 주세요.'],
    complete: ['비밀번호 변경 완료', '새 비밀번호가 저장되었습니다. 다음 로그인부터 사용해 주세요.'],
  }
  const [title, description] = headings[mode]
  const showFields = mode !== 'complete' && (mode !== 'reset' || recovery.status === 'ready')

  return (
    <div className="auth-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <button type="button" className="auth-close" aria-label="인증 창 닫기" onClick={onClose} disabled={busy}><X/></button>
        <div className="auth-brand"><span><Activity/></span><div><strong>ATLAS</strong><small>TRADING SYSTEM</small></div></div>
        <div className="auth-heading"><h2 id="auth-title">{title}</h2><p>{description}</p></div>

        {(mode === 'login' || mode === 'signup') && <div className="auth-tabs" role="tablist" aria-label="인증 방식">
          <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} disabled={busy} onClick={() => changeMode('login')}>로그인</button>
          <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'active' : ''} disabled={busy} onClick={() => changeMode('signup')}>회원가입</button>
        </div>}

        <form className="auth-form" onSubmit={handleSubmit}>
          {showFields && <>
            {mode !== 'reset' && <label><span>이메일</span><div className="auth-input"><Mail/><input ref={inputRef} type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" autoComplete="email" disabled={busy} required/></div></label>}
            {mode !== 'forgot' && <label><span>{mode === 'reset' ? '새 비밀번호' : '비밀번호'}</span><div className="auth-input"><LockKeyhole/><input ref={mode === 'reset' ? inputRef : undefined} type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="6자 이상 입력" minLength={6} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} disabled={busy} required/><button type="button" aria-label={showPassword ? '비밀번호 숨기기' : '비밀번호 보기'} disabled={busy} onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? <EyeOff/> : <Eye/>}</button></div></label>}
            {(mode === 'signup' || mode === 'reset') && <label><span>비밀번호 확인</span><div className="auth-input"><LockKeyhole/><input type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="비밀번호를 다시 입력" minLength={6} autoComplete="new-password" disabled={busy} required/></div></label>}
          </>}
          {recovery?.status === 'checking' && <p className="auth-message" role="status">재설정 링크를 확인하고 있습니다...</p>}
          {recovery?.status === 'error' && <p className="auth-message error" role="alert">{recovery.message}</p>}
          {message && <p className={`auth-message ${messageType}`} role={messageType === 'error' ? 'alert' : 'status'}>{message}</p>}
          {showFields && <button type="submit" className="auth-submit" disabled={busy}>{submitting ? '처리 중...' : { login: '로그인', signup: '회원가입', forgot: '재설정 메일 보내기', reset: '비밀번호 변경' }[mode]}</button>}
          {mode === 'complete' && <button type="button" className="auth-submit" onClick={onClose}>확인</button>}
        </form>
        {mode === 'login' && <button type="button" className="auth-link" disabled={busy} onClick={() => changeMode('forgot')}>비밀번호를 잊으셨나요?</button>}
        {mode === 'forgot' && <button type="button" className="auth-link" disabled={busy} onClick={() => changeMode('login')}>로그인으로 돌아가기</button>}
        {recovery?.status === 'error' && <button type="button" className="auth-link" onClick={() => changeMode('forgot')}>새 재설정 링크 요청</button>}
        <p className="auth-security"><LockKeyhole/>비밀번호와 증권사 API 키는 서로 분리하여 안전하게 관리합니다.</p>
      </section>
    </div>
  )
}
