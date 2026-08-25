import { useEffect, useRef, useState } from 'react'
import { Activity, Eye, EyeOff, LockKeyhole, Mail, X } from 'lucide-react'
import { isSupabaseConfigured, supabase } from '../services/supabaseClient'

const authErrorMessage = (error) => {
  const message = error?.message ?? ''
  if (/invalid login credentials/i.test(message)) return '이메일 또는 비밀번호가 올바르지 않습니다.'
  if (/email not confirmed/i.test(message)) return '이메일 인증을 완료한 후 로그인해 주세요.'
  if (/user already registered/i.test(message)) return '이미 가입된 이메일입니다.'
  if (/password should be at least/i.test(message)) return '비밀번호는 6자 이상 입력해 주세요.'
  return message || '인증 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'
}

export default function AuthModal({ open, onClose }) {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [messageType, setMessageType] = useState('error')
  const emailRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.setTimeout(() => emailRef.current?.focus(), 0)

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose, submitting])

  useEffect(() => {
    setMessage('')
    setConfirmPassword('')
  }, [mode])

  if (!open) return null

  const handleSubmit = async (event) => {
    event.preventDefault()
    setMessage('')

    if (!isSupabaseConfigured || !supabase) {
      setMessage('Supabase 환경 설정을 확인해 주세요.')
      return
    }
    if (mode === 'signup' && password !== confirmPassword) {
      setMessage('비밀번호가 서로 일치하지 않습니다.')
      return
    }

    setSubmitting(true)
    try {
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
    setMode(nextMode)
    setMessageType('error')
  }

  return (
    <div className="auth-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) onClose() }}>
      <section className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <button type="button" className="auth-close" aria-label="로그인 창 닫기" onClick={onClose} disabled={submitting}><X/></button>
        <div className="auth-brand"><span><Activity/></span><div><strong>ATLAS</strong><small>TRADING SYSTEM</small></div></div>
        <div className="auth-heading"><h2 id="auth-title">{mode === 'login' ? '다시 오신 것을 환영합니다' : 'ATLAS 계정 만들기'}</h2><p>{mode === 'login' ? '로그인하고 나만의 투자 환경을 불러오세요.' : '계정을 만들고 관심종목과 전략을 저장하세요.'}</p></div>

        <div className="auth-tabs" role="tablist" aria-label="인증 방식">
          <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => changeMode('login')}>로그인</button>
          <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'active' : ''} onClick={() => changeMode('signup')}>회원가입</button>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label><span>이메일</span><div className="auth-input"><Mail/><input ref={emailRef} type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" autoComplete="email" required/></div></label>
          <label><span>비밀번호</span><div className="auth-input"><LockKeyhole/><input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="6자 이상 입력" minLength={6} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required/><button type="button" aria-label={showPassword ? '비밀번호 숨기기' : '비밀번호 보기'} onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? <EyeOff/> : <Eye/>}</button></div></label>
          {mode === 'signup' && <label><span>비밀번호 확인</span><div className="auth-input"><LockKeyhole/><input type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="비밀번호를 다시 입력" minLength={6} autoComplete="new-password" required/></div></label>}
          {message && <p className={`auth-message ${messageType}`} role="status">{message}</p>}
          <button type="submit" className="auth-submit" disabled={submitting}>{submitting ? '처리 중...' : mode === 'login' ? '로그인' : '회원가입'}</button>
        </form>
        <p className="auth-security"><LockKeyhole/>비밀번호와 증권사 API 키는 서로 분리하여 안전하게 관리합니다.</p>
      </section>
    </div>
  )
}
