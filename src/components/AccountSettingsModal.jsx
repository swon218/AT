import { useEffect, useRef, useState } from 'react'
import { Activity, CheckCircle2, KeyRound, LockKeyhole, UserRound, X } from 'lucide-react'
import { supabase } from '../services/supabaseClient'
import { getIntegrationSettings, saveIntegrationSettings } from '../services/accountSettingsApi'
import KakaoConnectionSection from './KakaoConnectionSection'
import BrokerApiHelp from './BrokerApiHelp'
import {BROKERS} from '../utils/brokers'
import {CREDENTIAL_MAX_LENGTH, emptyBrokerCredentials, savedBrokerStatus, brokerSettingsState, brokerSettingsPayload, brokerSettingsInputError} from '../utils/integrationSettings'

const emptyCredentials = emptyBrokerCredentials()
const emptyStatus = savedBrokerStatus()

const profileErrorMessage = (error) => {
  if (error?.code === '23505') return '이미 사용 중인 닉네임입니다.'
  if (/profiles/i.test(error?.message || '')) return '먼저 Supabase profiles 마이그레이션을 실행해 주세요.'
  return error?.message || '개인 설정을 저장하지 못했습니다.'
}

function SecretField({ label, value, placeholder, disabled, onChange }) {
  return (
    <label className="account-field">
      <span>{label}</span>
      <div className="account-secret-input"><LockKeyhole/><input type="password" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} disabled={disabled} maxLength={CREDENTIAL_MAX_LENGTH} autoComplete="off"/></div>
    </label>
  )
}

export default function AccountSettingsModal({ open, user, onClose, onNicknameSaved, onIntegrationStatusChange, onIntegrationMutation }) {
  const [nickname, setNickname] = useState('')
  const [credentials, setCredentials] = useState(emptyCredentials)
  const [clearBrokers, setClearBrokers] = useState([])
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [status, setStatus] = useState(emptyStatus)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [integrationAvailable, setIntegrationAvailable] = useState(true)
  const [message, setMessage] = useState('')
  const [messageType, setMessageType] = useState('error')
  const userId = user?.id
  const operationEpoch = useRef(0)
  const context = useRef(null)
  context.current = {open, userId, saving, onClose}

  useEffect(() => {
    if (!open || !userId) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    let active = true
    operationEpoch.current++
    setLoading(true)
    setSaving(false)
    setNickname('')
    setMessage('')
    setCredentials(emptyCredentials)
    setClearBrokers([])
    setStatus(emptyStatus)

    Promise.allSettled([
      supabase.from('profiles').select('nickname').eq('id', userId).single(),
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
        setStatus(savedBrokerStatus(integrationResult.value))
        setIntegrationAvailable(true)
      } else {
        setIntegrationAvailable(false)
      }
    }).finally(() => active && setLoading(false))

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !context.current.saving) context.current.onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      active = false
      operationEpoch.current++
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, userId])

  if (!open || !user) return null

  const updateCredential = (field, value) => setCredentials((current) => ({ ...current, [field]: value }))
  const hasCredentialInput = clearBrokers.length > 0 || Object.values(credentials).some((value) => value.trim())

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
    const credentialError = brokerSettingsInputError(credentials, status, clearBrokers)
    if (credentialError) { setMessage(credentialError); return }

    setSaving(true)
    const epoch = operationEpoch.current
    const current = () => mounted.current && context.current.open && context.current.userId === userId && operationEpoch.current === epoch
    const affected = ['kiwoom', 'toss', 'nh', 'kb'].filter(broker => clearBrokers.includes(broker) ||
      Object.entries(credentials).some(([field, value]) => field.startsWith(broker) && value.trim()))
    onIntegrationMutation?.(affected, true)
    try {
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .update({ nickname: normalizedNickname || null })
        .eq('id', user.id)
        .select('nickname')
        .single()
      if (profileError) throw profileError
      if (!current()) return

      if (hasCredentialInput) {
        const nextStatus = savedBrokerStatus(await saveIntegrationSettings(brokerSettingsPayload(credentials, clearBrokers), user.id))
        if (!current()) return
        setStatus(nextStatus)
        onIntegrationStatusChange?.(nextStatus)
        setCredentials(emptyCredentials)
        setClearBrokers([])
      }

      onNicknameSaved(profile.nickname ?? '')
      setMessageType('success')
      setMessage(hasCredentialInput ? '닉네임과 보안 설정을 저장했습니다.' : '닉네임을 저장했습니다.')
    } catch (error) {
      if (current()) setMessage(profileErrorMessage(error))
    } finally {
      if (current()) { onIntegrationMutation?.(affected, false); setSaving(false) }
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
            <label className="account-field"><span>닉네임</span><div className="account-text-input"><input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="2~20자 닉네임" maxLength={20} disabled={loading || saving}/></div></label>
          </section>

          <section className="account-section">
            <div className="account-section-head account-broker-head"><div><KeyRound/><div><span className="account-broker-title"><strong>증권사 API</strong><BrokerApiHelp/></span><small>새 값을 입력한 항목만 교체됩니다.</small></div></div><div className="integration-badges account-saved-badges" aria-label="증권사 API 정보 저장 상태" aria-live="polite">{BROKERS.map(({id,shortName})=>{
              const state=brokerSettingsState(id,status,credentials,clearBrokers)
              return <b key={id} className={!loading && integrationAvailable && state.saved ? 'ready' : ''}>{!loading && integrationAvailable && state.saved && <CheckCircle2 aria-hidden="true"/>}<span>{shortName} {loading?'확인 중':!integrationAvailable?'확인 실패':state.saved?'저장됨':'미저장'}{state.dirty && <em>{state.deletion?'삭제 미저장':'변경사항 미저장'}</em>}</span></b>
            })}</div></div>
            <div className="account-field-grid">
              <SecretField label="키움 App Key" value={credentials.kiwoomAppKey} placeholder={status.kiwoomConfigured ? '저장됨 · 변경할 때만 입력' : '키움 App Key'} disabled={!integrationAvailable || loading || saving} onChange={(value) => updateCredential('kiwoomAppKey', value)}/>
              <SecretField label="키움 Secret Key" value={credentials.kiwoomSecretKey} placeholder={status.kiwoomConfigured ? '저장됨 · 변경할 때만 입력' : '키움 Secret Key'} disabled={!integrationAvailable || loading || saving} onChange={(value) => updateCredential('kiwoomSecretKey', value)}/>
              <SecretField label="토스 Client ID" value={credentials.tossApiKey} placeholder={status.tossConfigured ? '저장됨 · 변경할 때만 입력' : '토스 Client ID'} disabled={!integrationAvailable || loading || saving} onChange={(value) => updateCredential('tossApiKey', value)}/>
              <SecretField label="토스 Client Secret" value={credentials.tossSecretKey} placeholder={status.tossConfigured ? '저장됨 · 변경할 때만 입력' : '토스 Client Secret'} disabled={!integrationAvailable || loading || saving} onChange={(value) => updateCredential('tossSecretKey', value)}/>
              <SecretField label="NH투자증권 App Key" value={credentials.nhAppKey} placeholder={status.nhConfigured ? '저장됨 · 변경할 때만 입력' : '나무 PLUG App Key'} disabled={!integrationAvailable || loading || saving} onChange={(value) => updateCredential('nhAppKey', value)}/>
              <SecretField label="NH투자증권 Secret Key" value={credentials.nhSecretKey} placeholder={status.nhConfigured ? '저장됨 · 변경할 때만 입력' : '나무 PLUG App Secret'} disabled={!integrationAvailable || loading || saving} onChange={(value) => updateCredential('nhSecretKey', value)}/>
              <SecretField label="KB증권 App Key" value={credentials.kbAppKey} placeholder={status.kbConfigured ? '저장됨 · 변경할 때만 입력' : 'KB증권 App Key'} disabled={!integrationAvailable || loading || saving} onChange={(value) => updateCredential('kbAppKey', value)}/>
              <SecretField label="KB증권 Secret Key" value={credentials.kbSecretKey} placeholder={status.kbConfigured ? '저장됨 · 변경할 때만 입력' : 'KB증권 App Secret'} disabled={!integrationAvailable || loading || saving} onChange={(value) => updateCredential('kbSecretKey', value)}/>
            </div>
            <div className="account-broker-deletions" aria-label="저장된 증권사 키 삭제">
              {[['kiwoom', '키움'], ['toss', '토스'], ['nh', 'NH'], ['kb', 'KB']].map(([broker, label]) =>
                <label key={broker}><input type="checkbox" checked={clearBrokers.includes(broker)} disabled={loading || saving || !integrationAvailable || !status[`${broker}Configured`]} onChange={event => setClearBrokers(current => event.target.checked ? [...current, broker] : current.filter(item => item !== broker))}/>{label} 키 삭제</label>)}
            </div>
          </section>

          <KakaoConnectionSection key={userId} userId={userId}/>
          {!integrationAvailable && <p className="account-security-warning"><LockKeyhole/>VPS 암호화 저장 기능 연결 전에는 닉네임만 저장할 수 있습니다.</p>}
          {message && <p className={`auth-message ${messageType}`} role="status">{message}</p>}
          <button type="submit" className="auth-submit account-save" disabled={loading || saving}>{saving ? '저장 중...' : '설정 저장'}</button>
        </form>
      </section>
    </div>
  )
}
