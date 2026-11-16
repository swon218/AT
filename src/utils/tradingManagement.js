import {tradingReadiness} from '../../shared/tradingV1.js'
import {tradingConnectionStage} from './tradingPresentation.js'

export const tradingActive=session=>Boolean(session&&!['stopped','completed'].includes(session.status))
export const latestTradingSession=(sessions,code)=>sessions.find(row=>row.code===code&&tradingActive(row))||sessions.find(row=>row.code===code)
export function tradingConfigDirty(draft,saved) {
  if(!draft)return false
  if(!saved)return true
  const canonical=value=>JSON.stringify(Object.fromEntries(Object.entries(value||{}).filter(([,v])=>v!==undefined).map(([k,v])=>[k,['quantity','strategyRevision','manageQuantity'].includes(k)?Number(v):v]).sort(([a],[b])=>a.localeCompare(b))))
  return canonical(draft)!==canonical(saved.spec)
}
export function tradingExecutionBlock({config,sessions,strategies,connection,evidence,capability,flags,dirty,mode='LIVE',now}) {
  if(tradingActive(latestTradingSession(sessions,config.code)))return '현재 실행 중입니다.'
  if(dirty)return '변경사항 미저장 · 설정에서 저장한 뒤 실행해 주세요.'
  const stage=tradingConnectionStage(connection,evidence,now)
  if(stage!=='connected')return {checking:'개인 API 연결 확인 중',unconfigured:'개인 API 미등록',failed:'개인 API 연결 확인 실패',expired:'개인 API 연결 검증 만료'}[stage]||'개인 API 연결 확인 필요'
  if(!capability?.supported)return capability?.reason||'지원되지 않는 주문 기능입니다.'
  if(config.spec.broker!=='kiwoom'&&flags.storageV2===false)return '자동매매 V2 저장소 업데이트가 필요합니다.'
  if(!config.spec.accountRef)return '계좌 선택이 필요합니다.'
  if(!connection.accounts?.some(row=>row.ref===config.spec.accountRef))return '선택 계좌의 본인 접근 상태를 다시 확인해 주세요.'
  const strategy=strategies.find(row=>row.id===config.spec.strategyId&&Number(row.revision)===Number(config.spec.strategyRevision))
  if(!strategy)return '저장 전략이 변경되거나 삭제되었습니다. 설정에서 다시 저장해 주세요.'
  const readiness=tradingReadiness(strategy,config.spec.entryAction)
  if(!readiness.ready)return readiness.issues.join(' ')
  if(capability.ordersEnabled!==true)return '서버의 증권사 주문 기능이 비활성 또는 확인 불가 상태입니다.'
  if(!flags.workerEnabled||flags.workerReady===false)return 'worker 실행이 비활성 또는 확인 불가 상태입니다.'
  if(mode!=='LIVE'||!flags.liveEnabled)return 'LIVE 실행이 비활성입니다.'
  return ''
}
export function tradingExecutionSnapshot(config,session,strategies) {
  if(tradingActive(session))return {spec:session.snapshot?.spec||config.spec,strategy:session.snapshot?.strategy,policy:session.snapshot?.executionPolicy,accountLabel:session.snapshot?.accountLabel,applied:true}
  return {spec:config.spec,strategy:config.strategySnapshot||strategies.find(row=>row.id===config.spec.strategyId&&Number(row.revision)===Number(config.spec.strategyRevision)),policy:config.executionPolicy,accountLabel:config.accountLabel,applied:false}
}
export function tradingSessionFilter(sessions,filter) {
  return sessions.filter(row=>filter==='all'||filter==='active'&&tradingActive(row)||filter==='stopped'&&row.status==='stopped'||filter==='completed'&&row.status==='completed')
}
export function eligibleTradingSelection(selected,eligible) {
  const set=new Set(eligible)
  return selected.filter(code=>set.has(code))
}
export function selectTradingDetail(session,context,detail) {
  const candidate=detail?.sessions?.find(row=>row.id===session.id)
  const sameScope=candidate&&candidate.broker===session.broker&&candidate.account_ref===session.account_ref
  const fresh=sameScope&&Number.isInteger(Number(candidate.revision))&&Number(candidate.revision)>=Number(session.revision)
  if(!fresh)return {session,data:context}
  return {session:candidate,data:{...context,
    intents:(detail.intents||[]).filter(row=>row.session_id===session.id),
    events:(detail.events||[]).filter(row=>row.session_id===session.id)}}
}
