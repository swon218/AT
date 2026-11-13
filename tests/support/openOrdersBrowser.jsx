import React,{useCallback,useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import UnfilledOrdersPanel from '../../src/components/UnfilledOrdersPanel'
import '../../src/styles.css'
const hex=(c,n=64)=>c.repeat(n)
function Harness(){
  const [mode,setMode]=useState('normal'),[user,setUser]=useState('fixture-a'),[account,setAccount]=useState(''),[broker,setBroker]=useState('kiwoom'),[theme,setTheme]=useState('dark'),[revision,setRevision]=useState(0),[calls,setCalls]=useState([]),[tab,setTab]=useState(true)
  const sequence=useRef(0)
  const api=useCallback(async(b,p)=>{
    const scope=[user,b,account,mode].join(' / ')
    setCalls(v=>[...v.slice(-12),`${++sequence.current} · ${p.input?'MOCK WRITE':'MOCK READ'} · ${scope}`])
    await new Promise(resolve=>setTimeout(resolve,mode==='slow'?2500:100))
    if(mode==='error')throw Error('모의 증권사 연결 실패')
    if(p.input){if(mode==='changed')throw Object.assign(Error('주문 상태가 변경되었습니다. 새 목록에서 다시 확인해 주세요.'),{code:'order_changed'});if(mode==='unknown')throw Object.assign(Error('결과 확인 필요 · 증권사 앱에서 확인해 주세요.'),{code:'outcome_uncertain'});return {status:'accepted',originalOrderNumber:'1001',orderNumber:'2002',message:'모의 증권사에 요청이 접수되었습니다. 처리 완료는 별도 확인하세요.'}}
    const selected=account||hex('e',32),items=mode==='empty'||user==='fixture-b'?[]:Array.from({length:14},(_,i)=>({id:hex('a'),scope:hex('b'),version:hex('c'),accountRef:selected,name:i?'삼성전자우':'아주 긴 종목명 표시 및 매수 매도 부분체결 검증 종목',symbol:i?'005935':'005930',orderNumber:String(1001+i),side:i%2?'sell':'buy',orderedAt:i%3?'2026-11-13T10:00:00+09:00':null,orderPrice:i===2?null:70000,priceType:i===2?'market':'limit',orderType:i===2?'시장가':'지정가',quantity:10,filledQuantity:i===1?3:0,remainingQuantity:i===1?7:10,exchange:'KRX',session:'정규장',status:i===1?'부분체결':'미체결',canAmend:mode!=='partial'&&b!=='nh'&&!(b==='toss'&&i===1),canCancel:mode!=='partial'&&b!=='nh',managementNote:b==='nh'?'통합주문번호와 시장주문번호 연결 확인 전 조회만 지원합니다.':b==='toss'&&i===1?'부분체결 정정은 제한하며 전체 취소만 지원합니다.':''}))
    return {status:mode==='partial'?'partial':'success',reason:mode==='partial'?'page_limit':'',items:items.map((v,i)=>({...v,id:(i.toString(16)+v.id).slice(0,64)})),accounts:[{id:hex('e',32),label:'본인 계좌 1'},{id:hex('f',32),label:'본인 계좌 2'}],selectedAccountRef:selected,accountLabel:selected===hex('e',32)?'본인 계좌 1':'본인 계좌 2',accountScope:hex('d'),asOf:'2026-11-13',fetchedAt:new Date(mode==='stale'?Date.now()-120000:Date.now()).toISOString(),managementReady:true}
  },[mode,user,account])
  return <div style={{padding:16,maxWidth:1000,margin:'auto'}}>
    <p>로컬 모의 검증 전용 · 운영 API·계좌·주문·카카오 호출 없음</p>
    <div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:16}}>
      <button onClick={()=>{const next=theme==='dark'?'light':'dark';setTheme(next);document.documentElement.dataset.theme=next}}>라이트 / 다크</button>
      <label>상태<select aria-label="검증 상태" value={mode} onChange={e=>setMode(e.target.value)}>{['normal','empty','error','partial','stale','changed','unknown','slow'].map(v=><option key={v}>{v}</option>)}</select></label>
      <label>증권사<select aria-label="검증 증권사" value={broker} onChange={e=>setBroker(e.target.value)}>{['kiwoom','toss','nh','kb'].map(v=><option key={v}>{v}</option>)}</select></label>
      <button onClick={()=>setUser(user==='fixture-a'?'fixture-b':'fixture-a')}>계정 전환</button><button onClick={()=>setUser(user?'':'fixture-a')}>로그인 / 로그아웃</button><button onClick={()=>setTab(v=>!v)}>탭 이탈 / 복귀</button>
    </div>
    <article className="panel" style={{width:'100%',maxWidth:780}}>{tab&&<UnfilledOrdersPanel key={`${user}:${broker}:${account}`} broker={broker} userId={user} credentialVersion={1} accountRef={account} authenticated={!!user} brokerConfigured onAccountChange={setAccount} onAccountRefresh={()=>setRevision(v=>v+1)} api={api}/>}</article>
    <p>잔고 갱신 요청: {revision}</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}} aria-label="모의 요청 기록">{calls.join('\n')}</pre>
  </div>
}
document.documentElement.dataset.theme='dark'
createRoot(document.getElementById('root')).render(<React.StrictMode><Harness/></React.StrictMode>)
