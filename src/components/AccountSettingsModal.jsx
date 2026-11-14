import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Activity, CheckCircle2, KeyRound, LockKeyhole, Trash2, UserRound, X } from 'lucide-react'
import { supabase } from '../services/supabaseClient'
import { deleteIntegrationSettings, getIntegrationSettings, notifyIntegrationChange, saveIntegrationSettings, subscribeIntegrationChanges } from '../services/accountSettingsApi'
import KakaoConnectionSection from './KakaoConnectionSection'
import BrokerApiHelp from './BrokerApiHelp'
import { BROKERS } from '../utils/brokers'
import { CREDENTIAL_MAX_LENGTH, brokerCredentialFields, brokerIsStored, brokerSettingsInputError, brokerSettingsPayload, brokerSettingsState, emptyBrokerCredentials, reconcileBrokerDrafts, savedBrokerStatus } from '../utils/integrationSettings'
import './CredentialSettings.css'

const fieldLabels = {
  kiwoom: ['키움 App Key','키움 Secret Key'], toss: ['토스 Client ID','토스 Client Secret'],
  nh: ['NH투자증권 App Key','NH투자증권 Secret Key'], kb: ['KB증권 App Key','KB증권 Secret Key'],
}
const profileErrorMessage = error => error?.code === '23505' ? '이미 사용 중인 닉네임입니다.' : error?.message || '개인 설정을 저장하지 못했습니다.'

function SecretField({ label, value, stored, disabled, placeholder, onChange, inputRef }) {
  return <label className="account-field"><span>{label}</span><div className="account-secret-input"><LockKeyhole aria-hidden="true"/>
    <input ref={inputRef} type="password" value={stored ? '' : value} readOnly={stored} disabled={disabled || stored} onChange={event => onChange(event.target.value)} placeholder={stored ? '저장된 키가 있습니다' : placeholder} maxLength={CREDENTIAL_MAX_LENGTH} autoComplete="off" spellCheck={false}/>
  </div></label>
}

function DeleteCredentialConfirm({ broker, pending, onCancel, onConfirm }) {
  const titleId = useId(), bodyId = useId(), cancel = useRef(null), panel = useRef(null)
  const actions = useRef(null)
  actions.current = {pending,onCancel}
  useEffect(() => {
    const previous = document.activeElement
    cancel.current?.focus()
    const keydown = event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation()
        if (!actions.current.pending) actions.current.onCancel()
      }
      if (event.key === 'Tab') {
        const buttons = [...panel.current.querySelectorAll('button:not(:disabled)')]
        if (!buttons.length) { event.preventDefault(); return }
        if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1).focus() }
        else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0].focus() }
      }
    }
    document.addEventListener('keydown',keydown,true)
    return () => { document.removeEventListener('keydown',keydown,true); if (previous?.isConnected) previous.focus() }
  }, [])
  return createPortal(<div className="auth-overlay confirm-overlay credential-delete-overlay" onMouseDown={event => { event.stopPropagation(); if (event.target === event.currentTarget && !pending) onCancel() }}>
    <section ref={panel} className="confirm-dialog credential-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} aria-busy={pending}>
      <button type="button" className="auth-close" aria-label="삭제 확인 창 닫기" disabled={pending} onClick={onCancel}><X/></button>
      <span className="confirm-icon"><Trash2 aria-hidden="true"/></span><h2 id={titleId}>{broker.shortName} API 키 삭제</h2>
      <p id={bodyId}>저장된 {broker.name} API 키를 삭제하시겠습니까?<br/>삭제 후에는 해당 API를 사용하는 기능을 이용할 수 없으며, 다시 사용하려면 API 키를 등록해야 합니다.</p>
      <div className="confirm-actions"><button ref={cancel} type="button" disabled={pending} onClick={onCancel}>취소</button><button type="button" className="danger" disabled={pending} onClick={onConfirm}>{pending ? '삭제 중...' : '삭제 확인'}</button></div>
    </section>
  </div>,document.body)
}

export default function AccountSettingsModal({ open, user, onClose, onNicknameSaved, onIntegrationStatusChange, onIntegrationMutation }) {
  const [nickname,setNickname] = useState(''), [credentials,setCredentials] = useState(emptyBrokerCredentials)
  const [status,setStatus] = useState(savedBrokerStatus), [hasSnapshot,setHasSnapshot] = useState(false)
  const [readState,setReadState] = useState('loading'), [profileLoading,setProfileLoading] = useState(false)
  const [saving,setSaving] = useState(false), [deleting,setDeleting] = useState(null), [deleteTarget,setDeleteTarget] = useState(null)
  const [message,setMessage] = useState(''), [messageType,setMessageType] = useState('error')
  const [brokerNotice,setBrokerNotice] = useState(null)
  const mounted = useRef(false), epoch = useRef(0), readSequence = useRef(0), readAbort = useRef(null), mutationAbort = useRef(null), busy = useRef(false), remoteChange = useRef(null), inputRefs = useRef({})
  const context = useRef(null), statusRef = useRef(status), userId = user?.id
  statusRef.current = status
  context.current = {open,userId,onClose,deleteTarget}
  const current = (owner, started) => mounted.current && context.current.open && context.current.userId === owner && epoch.current === started
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  function acceptStatus(value, {publish = false, clearBroker} = {}) {
    const next = savedBrokerStatus(value)
    const previous = statusRef.current
    statusRef.current = next
    setStatus(next); setHasSnapshot(true)
    setReadState(next.lifecycleReady ? 'ready' : 'unsupported')
    setCredentials(draft => reconcileBrokerDrafts(draft,next,clearBroker))
    if (publish && (next.settingsVersion !== previous.settingsVersion || BROKERS.some(({id}) => next[`${id}Configured`] !== previous[`${id}Configured`] || next.brokerStored[id] !== previous.brokerStored[id]))) onIntegrationStatusChange?.(next)
    return next
  }

  async function refreshSettings({publish = false} = {}) {
    const owner = userId, started = epoch.current, sequence = ++readSequence.current
    readAbort.current?.abort()
    const controller = new AbortController(); readAbort.current = controller
    setReadState('loading')
    try {
      const value = await getIntegrationSettings(owner,controller.signal)
      if (!current(owner,started) || readSequence.current !== sequence) return null
      return acceptStatus(value,{publish})
    } catch {
      if (current(owner,started) && readSequence.current === sequence) setReadState('error')
      return null
    }
  }

  useEffect(() => {
    if (!open || !userId) return undefined
    epoch.current++; busy.current = false; remoteChange.current = null
    const owner = userId, started = epoch.current, previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    setNickname(''); setCredentials(emptyBrokerCredentials()); setStatus(savedBrokerStatus()); setHasSnapshot(false)
    setMessage(''); setBrokerNotice(null); setSaving(false); setDeleting(null); setDeleteTarget(null); setProfileLoading(true)
    refreshSettings()
    supabase.from('profiles').select('nickname').eq('id',owner).single().then(({data,error}) => {
      if (!current(owner,started)) return
      if (error) setMessage(profileErrorMessage(error)); else setNickname(data?.nickname ?? '')
    }).catch(error => { if (current(owner,started)) setMessage(profileErrorMessage(error)) }).finally(() => { if (current(owner,started)) setProfileLoading(false) })
    const keydown = event => { if (event.key === 'Escape' && !event.defaultPrevented && !busy.current && !context.current.deleteTarget) context.current.onClose() }
    const reload = event => {
      if (event && event.userId !== owner) return
      if (busy.current) { remoteChange.current = event?.brokers || BROKERS.map(broker => broker.id); return }
      setDeleteTarget(null)
      if (event) onIntegrationMutation?.(event.brokers,true)
      void refreshSettings({publish:true}).finally(() => { if (event && current(owner,started)) onIntegrationMutation?.(event.brokers,false) })
    }
    const focus = () => reload()
    const unsubscribe = subscribeIntegrationChanges(reload)
    window.addEventListener('keydown',keydown); window.addEventListener('focus',focus)
    return () => {
      epoch.current++; readSequence.current++; readAbort.current?.abort(); mutationAbort.current?.abort(); busy.current = false
      document.body.style.overflow = previousOverflow
      unsubscribe(); window.removeEventListener('keydown',keydown); window.removeEventListener('focus',focus)
    }
  }, [open,userId])

  if (!open || !user) return null
  const pending = saving || Boolean(deleting), ready = readState === 'ready' && status.lifecycleReady
  const hasCredentialInput = Object.values(credentials).some(value => value.trim())
  const updateCredential = (broker,field,value) => { if (!busy.current && ready && !brokerIsStored(broker,statusRef.current)) setCredentials(draft => ({...draft,[field]:value})) }
  const closeConfirmation = () => { if (!busy.current) setDeleteTarget(null) }
  const finishMutation = async (owner,started,affected) => {
    if (!current(owner,started)) return
    busy.current = false; setSaving(false); setDeleting(null)
    onIntegrationMutation?.(affected,false)
    if (remoteChange.current) { remoteChange.current = null; setDeleteTarget(null); await refreshSettings({publish:true}) }
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (busy.current || deleteTarget) return
    setMessage(''); setBrokerNotice(null); setMessageType('error')
    const name = nickname.trim(), inputError = brokerSettingsInputError(credentials,status)
    if (name && (name.length < 2 || name.length > 20)) { setMessage('닉네임은 2자 이상 20자 이하로 입력해 주세요.'); return }
    if (inputError) { setMessage(inputError); return }
    if (hasCredentialInput && !ready) { setMessage('API 저장 상태를 먼저 다시 확인해 주세요.'); return }
    const owner = userId, started = epoch.current, before = status, controller = new AbortController()
    const affected = BROKERS.filter(({id}) => brokerCredentialFields(id).some(field => credentials[field]?.trim())).map(({id}) => id)
    mutationAbort.current = controller; busy.current = true; setSaving(true)
    onIntegrationMutation?.(affected,true)
    try {
      const {data:profile,error} = await supabase.from('profiles').update({nickname:name || null}).eq('id',owner).select('nickname').single()
      if (error) throw error
      if (!current(owner,started)) return
      if (hasCredentialInput) {
        const value = await saveIntegrationSettings(brokerSettingsPayload(credentials,before),owner,{signal:controller.signal})
        if (!current(owner,started)) return
        acceptStatus(value,{publish:true})
        notifyIntegrationChange(owner,affected)
      }
      onNicknameSaved?.(profile.nickname ?? '')
      setMessageType('success'); setMessage(hasCredentialInput ? '닉네임과 API 정보를 저장했습니다.' : '닉네임을 저장했습니다.')
    } catch (error) {
      if (!current(owner,started)) return
      if (hasCredentialInput && (error.status === 409 || error.resultUnknown)) {
        const latest = await refreshSettings({publish:true})
        if (!current(owner,started)) return
        if (latest && latest.settingsVersion !== before.settingsVersion) notifyIntegrationChange(owner,affected)
        setMessage(latest ? '서버의 최신 저장 상태를 다시 불러왔습니다. 입력과 저장 상태를 확인한 뒤 다시 진행해 주세요.' : '저장 결과를 확인하지 못했습니다. 저장 상태를 다시 확인해 주세요.')
      } else setMessage(profileErrorMessage(error))
    } finally { await finishMutation(owner,started,affected) }
  }

  async function confirmDelete() {
    if (!deleteTarget || busy.current) return
    const {broker,version} = deleteTarget, owner = userId, started = epoch.current
    const tell = (text,type = 'error') => setBrokerNotice({broker:broker.id,text,type})
    if (!ready || version !== status.settingsVersion) { setDeleteTarget(null); tell('저장 상태가 변경되었습니다. 다시 확인한 뒤 삭제해 주세요.'); await refreshSettings({publish:true}); return }
    const controller = new AbortController(); mutationAbort.current = controller
    busy.current = true; setDeleting(broker.id); setMessage(''); setMessageType('error')
    onIntegrationMutation?.([broker.id],true)
    try {
      const value = await deleteIntegrationSettings(broker.id,version,owner,{signal:controller.signal})
      if (!current(owner,started)) return
      acceptStatus(value,{publish:true,clearBroker:broker.id}); setDeleteTarget(null)
      notifyIntegrationChange(owner,[broker.id])
      tell(`${broker.shortName} API 저장 정보를 삭제했습니다. 새 키를 등록할 수 있습니다.`,'success')
      requestAnimationFrame(() => { if (current(owner,started)) inputRefs.current[broker.id]?.focus() })
    } catch (error) {
      if (!current(owner,started)) return
      setDeleteTarget(null)
      if (error.status === 409 || error.resultUnknown) {
        const latest = await refreshSettings({publish:true})
        if (!current(owner,started)) return
        if (latest?.lifecycleReady && !brokerIsStored(broker.id,latest)) {
          setCredentials(draft => reconcileBrokerDrafts(draft,latest,broker.id))
          tell(`${broker.shortName} API 키가 저장되어 있지 않은 것을 확인했습니다. 새 키를 등록할 수 있습니다.`,'success')
          notifyIntegrationChange(owner,[broker.id])
        } else tell(latest ? '저장 상태가 변경되었거나 삭제되지 않았습니다. 최신 상태를 확인한 뒤 삭제 버튼을 다시 눌러 주세요.' : '삭제 결과를 확인하지 못했습니다. 저장 상태를 다시 확인해 주세요.')
      } else tell(`${profileErrorMessage(error)} 삭제 버튼을 다시 눌러 재시도할 수 있습니다.`)
    } finally { await finishMutation(owner,started,[broker.id]) }
  }

  return <>
    <div className="auth-overlay account-overlay" inert={Boolean(deleteTarget)} onMouseDown={event => { if (event.target === event.currentTarget && !pending && !deleteTarget) onClose() }}>
      <section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-settings-title">
        <button type="button" className="auth-close" aria-label="개인 설정 닫기" onClick={onClose} disabled={pending || Boolean(deleteTarget)}><X/></button>
        <div className="auth-brand"><span><Activity/></span><div><strong>ATLAS</strong><small>ACCOUNT SETTINGS</small></div></div>
        <div className="account-heading"><h2 id="account-settings-title">개인 설정</h2><p>{user.email}</p></div>
        <form className="account-settings-form" onSubmit={handleSubmit}>
          <section className="account-section"><div className="account-section-head"><div><UserRound/><span><strong>프로필</strong><small>ATLAS에서 사용할 이름입니다.</small></span></div></div>
            <label className="account-field"><span>닉네임</span><div className="account-text-input"><input value={nickname} onChange={event => setNickname(event.target.value)} placeholder="2~20자 닉네임" maxLength={20} disabled={profileLoading || pending}/></div></label>
          </section>
          <section className="account-section">
            <div className="account-section-head account-broker-head"><div><KeyRound/><div><span className="account-broker-title"><strong>증권사 API</strong><BrokerApiHelp/></span><small>저장된 키는 삭제한 후 다시 등록할 수 있습니다.</small></div></div>
              <div className="integration-badges account-saved-badges" aria-label="증권사 API 정보 저장 상태" aria-live="polite">{BROKERS.map(({id,shortName}) => {
                const state = brokerSettingsState(id,status,credentials)
                return <b key={id} className={hasSnapshot && state.saved ? 'ready' : ''}>{hasSnapshot && state.saved && <CheckCircle2 aria-hidden="true"/>}<span>{shortName} {!hasSnapshot ? readState === 'loading' ? '확인 중' : '확인 실패' : state.saved ? '저장됨' : state.stored ? '일부 정보 저장됨' : '미저장'}{state.dirty && <em>변경사항 미저장</em>}</span></b>
              })}</div>
            </div>
            {readState !== 'ready' && <div className="credential-read-status" role="status"><span>{readState === 'loading' ? 'API 저장 상태를 확인하고 있습니다.' : readState === 'unsupported' ? 'API 키 관리 기능을 준비 중입니다. 잠시 후 다시 확인해 주세요.' : 'API 저장 상태를 확인하지 못했습니다. 다시 확인해 주세요.'}</span><button type="button" disabled={readState === 'loading' || pending} onClick={() => refreshSettings({publish:true})}>저장 상태 다시 확인</button></div>}
            <div className="credential-broker-list">{BROKERS.map(broker => {
              const state = brokerSettingsState(broker.id,status,credentials), fields = brokerCredentialFields(broker.id)
              return <section key={broker.id} className="credential-broker-card" aria-label={`${broker.shortName} API 정보`}>
                <h3>{broker.name}</h3><div className="account-field-grid">{fields.map((field,index) => <SecretField key={field} inputRef={index === 0 ? element => { inputRefs.current[broker.id] = element } : undefined} label={fieldLabels[broker.id][index]} value={credentials[field]} stored={state.stored} disabled={!ready || pending} placeholder={!ready ? '저장 상태 확인 필요' : fieldLabels[broker.id][index]} onChange={value => updateCredential(broker.id,field,value)}/>)}</div>
                {state.stored && <p className="credential-locked-note">API 키를 변경하려면 저장된 키를 삭제한 후 다시 등록해 주세요.</p>}
                {brokerNotice?.broker === broker.id && <p className={`credential-broker-notice ${brokerNotice.type}`} role="status">{brokerNotice.text}</p>}
              </section>
            })}</div>
            <div className="credential-delete-actions" role="group" aria-label="증권사별 API 키 삭제">{BROKERS.map(broker => <button key={broker.id} type="button" className="credential-delete-button" disabled={!ready || pending || !brokerIsStored(broker.id,status)} onClick={() => { setMessage(''); setBrokerNotice(null); setDeleteTarget({broker,version:status.settingsVersion}) }}><Trash2 aria-hidden="true"/><span>{broker.shortName} API 키 삭제</span></button>)}</div>
            <p className="credential-delete-note">삭제는 ATLAS의 저장 정보만 제거합니다. 증권사 키 발급 취소나 미체결 주문 취소는 실행하지 않습니다.</p>
          </section>
          <KakaoConnectionSection key={userId} userId={userId}/>
          {message && <p className={`auth-message ${messageType}`} role="status">{message}</p>}
          <button type="submit" className="auth-submit account-save" disabled={profileLoading || pending || Boolean(deleteTarget) || hasCredentialInput && !ready}>{saving ? '저장 중...' : deleting ? '삭제 중...' : '설정 저장'}</button>
        </form>
      </section>
    </div>
    {deleteTarget && <DeleteCredentialConfirm broker={deleteTarget.broker} pending={Boolean(deleting)} onCancel={closeConfirmation} onConfirm={confirmDelete}/>}
  </>
}
