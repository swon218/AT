import { useEffect, useState } from 'react'
import { Activity, Bot, CheckCircle2, KeyRound, LockKeyhole, UserRound, X } from 'lucide-react'
import { supabase } from '../services/supabaseClient'
import { getIntegrationSettings, saveIntegrationSettings } from '../services/accountSettingsApi'

const emptyCredentials = {
  kiwoomAppKey: '',
  kiwoomSecretKey: '',
  tossApiKey: '',
  tossSecretKey: '',
  telegramBotToken: '',
}

const emptyStatus = {
  kiwoomConfigured: false,
  tossConfigured: false,
  telegramConfigured: false,
}

const profileErrorMessage = (error) => {
  if (error?.code === '23505') return '이미 사용 중인 닉네임입니다.'
  if (/profiles/i.test(error?.message || '')) return '먼저 Supabase profiles 마이그레이션을 실행해 주세요.'
  return error?.message || '개인 설정을 저장하지 못했습니다.'
}

function SecretField({ label, value, placeholder, disabled, onChange }) {
  return (
    <label className="account-field">
      <span>{label}</span>
      <div className="account-secret-input"><LockKeyhole/><input type="password" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} disabled={disabled} autoComplete="off"/></div>
    </label>
  )
}

export default function AccountSettingsModal({ open, user, onClose, onNicknameSaved, onIntegrationStatusChange }) {
  const [nickname, setNickname] = useState('')
  const [credentials, setCredentials] = useState(emptyCredentials)
  const [status, setStatus] = useState(emptyStatus)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [integrationAvailable, setIntegrationAvailable] = useState(true)
  const [message, setMessage] = useState('')
  const [messageType, setMessageType] = useState('error')

  useEffect(() => {
    if (!open || !user) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    let active = true
    setLoading(true)
    setMessage('')
    setCredentials(emptyCredentials)

    Promise.allSettled([
      supabase.from('profiles').select('nickname').eq('id', user.id).single(),
      getIntegrationSettings(),
    ]).then(([profileResult, integrationResult]) => {
      if (!active) return
      if (profileResult.status === 'fulfilled' && !profileResult.value.error) {
        setNickname(profileResult.value.data?.nickname ?? '')
      } else {
        const error = profileResult.status === 'fulfilled' ? profileResult.value.error : profileResult.reason
        setMessage(profileErrorMessage(error))
      }

      if (integrationResult.status === 'fulfilled') {
        setStatus({ ...emptyStatus, ...integrationResult.value })
        setIntegrationAvailable(true)
      } else {
        setIntegrationAvailable(false)
      }
    }).finally(() => active && setLoading(false))

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      active = false
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, user, onClose])

  if (!open || !user) return null

  const updateCredential = (field, value) => setCredentials((current) => ({ ...current, [field]: value }))
  const hasCredentialInput = Object.values(credentials).some((value) => value.trim())

  const handleSubmit = async (event) => {
    event.preventDefault()
    const normalizedNickname = nickname.trim()
    setMessage('')
    setMessageType('error')

    if (normalizedNickname && (normalizedNickname.length < 2 || normalizedNickname.length > 20)) {
      setMessage('닉네임은 2자 이상 20자 이하로 입력해 주세요.')
      return
    }
    if (hasCredentialInput && !integrationAvailable) {
      setMessage('VPS의 암호화 저장 API를 먼저 설정해야 API 키와 토큰을 저장할 수 있습니다.')
      return
    }

    setSaving(true)
    try {
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .update({ nickname: normalizedNickname || null })
        .eq('id', user.id)
        .select('nickname')
        .single()
      if (profileError) throw profileError

      if (hasCredentialInput) {
        const nextStatus = await saveIntegrationSettings(credentials)
        setStatus({ ...emptyStatus, ...nextStatus })
        onIntegrationStatusChange?.({ ...emptyStatus, ...nextStatus })
        setCredentials(emptyCredentials)
      }

      onNicknameSaved(profile.nickname ?? '')
      setMessageType('success')
      setMessage(hasCredentialInput ? '닉네임과 보안 설정을 저장했습니다.' : '닉네임을 저장했습니다.')
    } catch (error) {
      setMessage(profileErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="auth-overlay account-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose() }}>
      <section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-settings-title">
        <button type="button" className="auth-close" aria-label="개인 설정 닫기" onClick={onClose} disabled={saving}><X/></button>
        <div className="auth-brand"><span><Activity/></span><div><strong>ATLAS</strong><small>ACCOUNT SETTINGS</small></div></div>
        <div className="account-heading"><h2 id="account-settings-title">개인 설정</h2><p>{user.email}</p></div>

        <form className="account-settings-form" onSubmit={handleSubmit}>
          <section className="account-section">
            <div className="account-section-head"><div><UserRound/><span><strong>프로필</strong><small>ATLAS에서 사용할 이름입니다.</small></span></div></div>
            <label className="account-field"><span>닉네임</span><div className="account-text-input"><input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="2~20자 닉네임" maxLength={20} disabled={loading}/></div></label>
          </section>

          <section className="account-section">
            <div className="account-section-head"><div><KeyRound/><span><strong>증권사 API</strong><small>새 값을 입력한 항목만 교체됩니다.</small></span></div><div className="integration-badges"><b className={status.kiwoomConfigured ? 'ready' : ''}>{status.kiwoomConfigured ? <CheckCircle2/> : null}키움</b><b className={status.tossConfigured ? 'ready' : ''}>{status.tossConfigured ? <CheckCircle2/> : null}토스</b></div></div>
            <div className="account-field-grid">
              <SecretField label="키움 App Key" value={credentials.kiwoomAppKey} placeholder={status.kiwoomConfigured ? '저장됨 · 변경할 때만 입력' : '키움 App Key'} disabled={!integrationAvailable || loading} onChange={(value) => updateCredential('kiwoomAppKey', value)}/>
              <SecretField label="키움 Secret Key" value={credentials.kiwoomSecretKey} placeholder={status.kiwoomConfigured ? '저장됨 · 변경할 때만 입력' : '키움 Secret Key'} disabled={!integrationAvailable || loading} onChange={(value) => updateCredential('kiwoomSecretKey', value)}/>
              <SecretField label="토스 Client ID" value={credentials.tossApiKey} placeholder={status.tossConfigured ? '저장됨 · 변경할 때만 입력' : '토스 Client ID'} disabled={!integrationAvailable || loading} onChange={(value) => updateCredential('tossApiKey', value)}/>
              <SecretField label="토스 Client Secret" value={credentials.tossSecretKey} placeholder={status.tossConfigured ? '저장됨 · 변경할 때만 입력' : '토스 Client Secret'} disabled={!integrationAvailable || loading} onChange={(value) => updateCredential('tossSecretKey', value)}/>
            </div>
          </section>

          <section className="account-section">
            <div className="account-section-head"><div><Bot/><span><strong>텔레그램</strong><small>자동매매와 체결 알림에 사용합니다.</small></span></div><div className="integration-badges"><b className={status.telegramConfigured ? 'ready' : ''}>{status.telegramConfigured ? <CheckCircle2/> : null}봇</b></div></div>
            <SecretField label="Telegram Bot Token" value={credentials.telegramBotToken} placeholder={status.telegramConfigured ? '저장됨 · 변경할 때만 입력' : '123456789:AA...'} disabled={!integrationAvailable || loading} onChange={(value) => updateCredential('telegramBotToken', value)}/>
          </section>

          {!integrationAvailable && <p className="account-security-warning"><LockKeyhole/>VPS 암호화 저장 기능 연결 전에는 닉네임만 저장할 수 있습니다.</p>}
          {message && <p className={`auth-message ${messageType}`} role="status">{message}</p>}
          <button type="submit" className="auth-submit account-save" disabled={loading || saving}>{saving ? '저장 중...' : '설정 저장'}</button>
        </form>
      </section>
    </div>
  )
}
