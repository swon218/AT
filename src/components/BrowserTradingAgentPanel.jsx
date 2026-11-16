import { useEffect, useRef } from 'react'
import TradingAgentPanel from './TradingAgentPanel'
import { createBrowserTradingEngine, BROWSER_TRADING_MODE } from '../utils/browserTradingEngine'
import { createBrowserTradingMarket } from '../services/browserTradingMarket'
import { createBrowserTradingRuntime } from '../services/browserTradingRuntime'

export default function BrowserTradingAgentPanel({userId,onLogin,watchlist,strategies,credentialRevision=0,engineFactory=createBrowserTradingEngine,marketFactory=createBrowserTradingMarket}) {
  const current=useRef(null)
  const lifecycle=useRef(0)
  if(!current.current || current.current.owner!==userId){
    current.current?.runtime?.dispose()
    let storage
    try{storage=window.localStorage}catch{/* The engine retains an in-memory scope. */}
    const engine=userId?engineFactory({userId,storage}):null
    const scope={owner:userId,engine,hasCatalog:false,catalogReady:false,catalogError:'',runtime:null}
    scope.runtime=engine?createBrowserTradingRuntime({userId,engine,market:marketFactory(),visible:()=>document.visibilityState!=='hidden',available:()=>scope.hasCatalog&&scope.catalogReady&&!scope.catalogError}):null
    current.current=scope
  }
  const scope=current.current,{engine,runtime}=scope
  runtime?.setCredentialRevision(credentialRevision)
  const ready=Boolean(watchlist.ready&&!strategies.loading)
  let catalogError=watchlist.readError||strategies.error
  if(engine&&ready&&!catalogError){
    try{engine.setCatalog({watchlist:watchlist.rows,strategies:strategies.rows});scope.hasCatalog=true}
    catch(error){catalogError=error.message||'관심종목과 전략을 확인할 수 없습니다.'}
  }
  // Keep the last validated catalog while a background refresh is loading.
  // The synchronous gate also prevents an in-flight observation from applying
  // before the error effect has aborted the request and stopped the runs.
  scope.catalogReady=ready
  scope.catalogError=catalogError||''
  useEffect(()=>{if(runtime&&catalogError)runtime.suspend('catalog_unavailable')},[runtime,catalogError])
  useEffect(()=>{
    if(!runtime)return
    const generation=++lifecycle.current
    runtime.activate()
    const tick=()=>{if(scope.hasCatalog&&scope.catalogReady&&!scope.catalogError&&document.visibilityState!=='hidden')void runtime.tick()}
    const visibility=()=>{if(document.visibilityState==='hidden')runtime.suspend('screen_hidden')}
    const pagehide=()=>runtime.suspend('screen_closed')
    const timer=setInterval(tick,10_000)
    document.addEventListener('visibilitychange',visibility)
    window.addEventListener('pagehide',pagehide)
    return()=>{
      clearInterval(timer)
      document.removeEventListener('visibilitychange',visibility)
      window.removeEventListener('pagehide',pagehide)
      runtime.suspend('screen_closed')
      // StrictMode replays child effects before this parent's setup. Keep local
      // reads available during that replay, but dispose after a real unmount.
      queueMicrotask(()=>{if(lifecycle.current===generation)runtime.dispose()})
    }
  },[runtime])
  const retry=()=>{watchlist.refresh();strategies.refresh()}
  if(userId&&!scope.hasCatalog&&catalogError)return <section className="agent-mode-card"><h2>자동매매 에이전트</h2><p role="alert">{catalogError}</p><button type="button" onClick={retry}>다시 확인</button></section>
  if(userId&&!scope.hasCatalog)return <section className="agent-mode-card"><h2>자동매매 에이전트</h2><p role="status">관심종목과 전략을 불러오는 중입니다.</p></section>
  return <>
    {userId&&catalogError&&<div className="trading-notice" role="alert">{catalogError} · 실행을 정지했습니다. 목록을 다시 확인한 뒤 직접 시작해 주세요. <button type="button" onClick={retry}>다시 확인</button></div>}
    {userId&&!catalogError&&!ready&&<p role="status">관심종목과 전략을 갱신하는 중입니다. 마지막으로 확인한 설정을 표시합니다.</p>}
    <TradingAgentPanel key={userId||'guest'} userId={userId} onLogin={onLogin} credentialRevision={credentialRevision}
      executionMode={BROWSER_TRADING_MODE} api={runtime?.api||guestApi}/>
  </>
}
const guestApi=async()=>{throw new Error('로그인 후 사용할 수 있습니다.')}
