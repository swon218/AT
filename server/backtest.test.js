import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_BACKTEST, runBacktest, validateExecutionSettings, backtestReadiness } from '../src/utils/backtest.js'
import { calculateConditionEvaluator, defaultEntryCondition, getConditionFields, normalizeRiskSettings, strategyReadiness, validateEntryConditions } from '../src/utils/entryConditions.js'
import { createIndicatorConfig, INDICATOR_CATALOG } from '../src/utils/indicators.js'

const date = index => new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10)
const rows = values => values.map((v, i) => typeof v === 'number' ? ({time:date(i),open:v,high:v*1.001,low:v*.999,close:v,volume:100,tradable:1}) : ({time:date(i),volume:100,tradable:1,...v}))
const ma = {...createIndicatorConfig('ma'),shortPeriod:1,longPeriod:2}
const condition = (left='close',operator='gt',value=0) => ({indicatorId:'ma',enabled:true,left,operator,right:{type:'constant',value}})
const options = (patch={}) => ({...structuredClone(DEFAULT_BACKTEST),initialQuantity:1,takeProfitPct:5,stopLossPct:2,entryConditions:[condition()],...patch})
const run = (values,patch={}) => runBacktest(rows(values),[ma],options(patch))

 test('no qualifying signal leaves capital and returns uncalculated without fictitious funding',()=>{
  const r=run([100,101,102],{entryConditions:[condition('close','gt',1000)]})
  assert.equal(r.initialCapital,null);assert.equal(r.finalEquity,null);assert.equal(r.returnPct,null)
  assert.equal(r.cash,null);assert.equal(r.entryCount,0);assert.equal(r.winRate,null)
  assert(r.equity.every(p=>p.value===null));assert(!JSON.stringify(r).includes('NaN'))
 })
 test('first actual next-open fill determines baseline and exact quantity; prior capital and costs are ignored',()=>{
  const r=run([{open:100,high:101,low:99,close:100},{open:120,high:121,low:119,close:120},{open:121,high:123,low:120,close:123}],{initialQuantity:2,initialCapital:999999,feePct:4,taxPct:4,slippagePct:4})
  assert.equal(r.initialCapital,240);assert.equal(r.openPosition.entrySignal,date(0));assert.equal(r.openPosition.entryDate,date(1))
  assert.equal(r.openPosition.entryPrice,120);assert.equal(r.openPosition.quantity,2);assert.equal(r.finalEquity,246)
  assert.equal(r.cash,0);assert.equal(r.costs,0);assert.equal(r.unrealizedPnl,6);assert.equal(r.returnPct,2.5)
  assert(r.assumptions[0].includes('반영하지 않은'))
 })
 test('signals before start never buy at start, and signals at end cannot fill outside range',()=>{
  const r=run([100,101,102,103],{start:date(1),end:date(2)})
  assert.equal(r.firstSignalDate,date(1));assert.equal(r.openPosition.entryDate,date(2));assert.equal(r.equity[0].value,null)
  const one=run([100,101,102],{start:date(1),end:date(1)})
  assert.equal(one.entryCount,0);assert.equal(one.initialCapital,null);assert.equal(one.unfilledSignal.date,date(1))
 })
 test('a weekend start begins signals on the next supplied trading day, never the preceding close',()=>{
  const data=rows([100,100,101]).map((c,i)=>({...c,time:['2025-01-03','2025-01-06','2025-01-07'][i]}))
  const r=runBacktest(data,[ma],options({start:'2025-01-04',end:'2025-01-07',tradingDays:['2025-01-03','2025-01-06','2025-01-07'],calendarThrough:'2025-01-07'}))
  assert.equal(r.firstSignalDate,'2025-01-06');assert.equal(r.openPosition.entryDate,'2025-01-07')
 })
 test('intraday take-profit and stop-loss use entry-derived thresholds',()=>{
  const tp=run([100,{open:100,high:106,low:99,close:103}])
  assert.equal(tp.trades[0].exitPrice,105);assert.equal(tp.trades[0].pnl,5);assert.equal(tp.takeProfitCount,1)
  const sl=run([100,{open:100,high:104,low:97,close:99}])
  assert.equal(sl.trades[0].exitPrice,98);assert.equal(sl.trades[0].pnl,-2);assert.equal(sl.stopLossCount,1)
 })
 test('both thresholds on entry day preserve two events and stop-first ambiguity',()=>{
  const r=run([100,{open:100,high:106,low:97,close:100}])
  assert.equal(r.events.length,2);assert.equal(r.events[0].date,r.events[1].date)
  assert.deepEqual(r.events.map(e=>e.type),['entry','stop-loss']);assert.equal(r.trades[0].exitPrice,98)
  assert.equal(r.ambiguousCount,1);assert.equal(r.trades[0].ambiguous,true);assert.match(r.trades[0].reason,/순서 불명확.*손절 우선/)
 })
 test('existing positions gap through thresholds at open rather than fabricated limit fills',()=>{
  for(const [price,type,pnl]of[[80,'stop-loss',-20],[120,'take-profit',20]]){
   const r=run([100,100,{open:price,high:price+1,low:price-1,close:price}])
   assert.equal(r.trades[0].exitDate,date(2));assert.equal(r.trades[0].exitPrice,price);assert.equal(r.trades[0].exitType,type)
   assert.equal(r.trades[0].pnl,pnl);assert.equal(r.trades[0].gap,true)
  }
 })
 test('fixed sizing preserves cash profits, skips unaffordable signals and re-evaluates fresh signals',()=>{
  const r=run([100,{open:100,high:110,low:100,close:110},120,100],{takeProfitPct:10})
  assert.equal(r.trades[0].quantity,1);assert.equal(r.skippedSignals.length,1);assert.equal(r.insufficientCashCount,1)
  assert.equal(r.skippedSignals[0].date,date(2));assert.equal(r.skippedSignals[0].reasonCode,'insufficient_cash')
  assert.equal(r.openPosition.entryDate,date(3));assert.equal(r.openPosition.quantity,1);assert.equal(r.cash,10)
  assert.equal(r.finalEquity,110);assert.equal(r.realizedPnl,10)
 })
 test('reinvestment example uses only 520000 cash for four 110000 shares with 80000 left',()=>{
  const r=run([200000,{open:200000,high:520000,low:200000,close:520000},110000],{takeProfitPct:160,stopLossPct:2,quantityMode:'reinvest'})
  assert.equal(r.initialCapital,200000);assert.equal(r.realizedPnl,320000);assert.equal(r.openPosition.quantity,4)
  assert.equal(r.cash,80000);assert.equal(r.finalEquity,520000);assert.equal(r.returnPct,160)
 })
 test('reinvestment grows after profit and shrinks after loss without re-adding old holdings',()=>{
  const r=run([100,{open:100,high:110,low:100,close:110},{open:90,high:91,low:89,close:90},{open:80,high:82,low:79,close:80},100],{initialQuantity:10,takeProfitPct:10,stopLossPct:10,quantityMode:'reinvest'})
  assert.deepEqual(r.events.filter(e=>e.type==='entry').map(e=>e.quantity),[10,12,9]);assert.equal(r.cash,80)
  assert.equal(r.finalEquity,980);assert.equal(r.realizedPnl,-20);assert.equal(r.returnPct,-2)
 })
 test('exact decimal sizing permits a cash-equal one-share purchase and avoids binary floor loss',()=>{
  const r=run([.3,{open:.3,high:.6,low:.3,close:.6},.2],{takeProfitPct:100,stopLossPct:10,quantityMode:'reinvest'})
  assert.equal(r.openPosition.quantity,3);assert.equal(r.cash,0);assert.equal(r.finalEquity,.6)
  const equal=run([100,{open:100,high:110,low:100,close:110},110],{takeProfitPct:10,quantityMode:'reinvest'})
  assert.equal(equal.openPosition.quantity,1);assert.equal(equal.cash,0)
 })
 test('one-share shortage skips rather than borrowing or waiting forever',()=>{
  const r=run([100,{open:100,high:101,low:98,close:98},100,100],{quantityMode:'reinvest'})
  assert.equal(r.trades.length,1);assert.equal(r.entryCount,1);assert.equal(r.insufficientCashCount,2);assert.equal(r.cash,98)
  assert.equal(r.openPosition,null)
 })
 test('sale and fresh close signal cannot reenter on the same day',()=>{
  const r=run([100,{open:100,high:105,low:99,close:105},100],{takeProfitPct:5})
  assert.deepEqual(r.events.filter(e=>e.type==='entry').map(e=>e.date),[date(1),date(2)])
  assert.equal(r.events.filter(e=>e.date===date(1)).length,2)
 })
 test('unclosed positions are marked to last close and excluded from completed-trade statistics',()=>{
  const r=run([100,100,101],{initialQuantity:3})
  assert.equal(r.closedTrades,0);assert.equal(r.winRate,null);assert.equal(r.openPosition.markPrice,101)
  assert.equal(r.openPosition.returnPct,1);assert.equal(r.unrealizedPnl,3);assert.equal(r.realizedPnl,0)
  assert.equal(r.finalEquity,303);assert.equal(r.events.filter(e=>e.type!=='entry').length,0)
 })
 test('suspension cancels the prior signal and does not fill at an invented price',()=>{
  const r=run([100,{open:0,high:0,low:0,close:100,volume:0,tradable:0},100,100])
  assert.equal(r.events[0].date,date(3));assert.equal(r.skippedSignals[0].code,'not_tradable')
 })
 test('future changes cannot alter any earlier fill or equity point',()=>{
  const prefix=rows([100,{open:100,high:105,low:99,close:105},100,100])
  const a=runBacktest(prefix,[ma],options()),b=runBacktest([...prefix,...rows([300,1]).map((c,i)=>({...c,time:date(i+4)}))],[ma],options())
  assert.deepEqual(a.equity,b.equity.slice(0,4));assert.deepEqual(a.trades,b.trades.slice(0,a.trades.length))
 })
 test('AND/OR, inclusive/equal operators and crossover compare calculated unrounded values',()=>{
  const data=rows([100,100,101,100]),evaluate=calculateConditionEvaluator(data,[ma])
  assert.equal(evaluate(condition('close','eq',100),0),true);assert.equal(evaluate(condition('close','eq',100.00000000001),0),false)
  assert.equal(evaluate(condition('close','gte',100),0),true);assert.equal(evaluate(condition('close','lte',100),0),true)
  const cross={...condition('short','crossUp',0),right:{type:'series',field:'long'}}
  assert.equal(evaluate(cross,0),null);assert.equal(evaluate(cross,1),null);assert.equal(evaluate(cross,2),true);assert.equal(evaluate(cross,3),false)
  const rules=[condition('close','gt',200),condition('close','gte',100)]
  assert.equal(runBacktest(data,[ma],options({entryConditions:rules})).entryCount,0)
  assert(runBacktest(data,[ma],options({entryConditions:rules,entryMode:'any'})).entryCount>0)
 })
 test('all twelve chart indicators expose working condition fields; reference-only warmup cannot block entries',()=>{
  const data=rows(Array.from({length:90},(_,i)=>({open:100+i%11,high:105+i%11,low:95+i%11,close:102+i%11,volume:100+i})))
  for(const {id}of INDICATOR_CATALOG){
   const c=createIndicatorConfig(id),fields=getConditionFields(c),ev=calculateConditionEvaluator(data,[c])
   assert(fields.length>0,id)
   for(const f of fields){ const cond={indicatorId:id,enabled:true,left:f.id,operator:'eq',right:{type:'constant',value:f.stateValues?.[0]??(f.min??0)}};assert.doesNotThrow(()=>validateEntryConditions([c],{entryMode:'all',entryConditions:[cond]}));assert.notEqual(ev(cond,89),null,`${id}.${f.id}`) }
  }
  const reference={...createIndicatorConfig('rsi'),period:500}
  assert.deepEqual(runBacktest(rows([100,100,101]),[ma,reference],options()),run([100,100,101]))
 })
 test('Bollinger high/close conditions are explicit and can differ on the same bar',()=>{
  const bb={...createIndicatorConfig('bollinger'),period:2,multiplier:1},data=rows([{open:100,high:101,low:99,close:100},{open:100,high:110,low:99,close:100}]),ev=calculateConditionEvaluator(data,[bb])
  const c={indicatorId:'bollinger',enabled:true,left:'high',operator:'gt',right:{type:'series',field:'upper'}}
  assert.equal(ev(c,1),true);assert.equal(ev({...c,left:'close'},1),false)
 })
 test('partial strategies stay non-executable, orphan/unit/state invalid conditions fail closed',()=>{
  assert(strategyReadiness([ma],DEFAULT_BACKTEST).length>=2)
  assert.throws(()=>run([100,101],{entryConditions:[]}),/한 개 이상/)
  assert.throws(()=>validateEntryConditions([ma],{entryConditions:[{...condition(),indicatorId:'rsi'}]}),/지표/)
  const vol=createIndicatorConfig('volume-ma')
  assert.throws(()=>validateEntryConditions([ma,vol],{entryConditions:[{...condition(),right:{type:'series',field:'average',indicatorId:'volume-ma'}}]}),/단위/)
  const st=createIndicatorConfig('supertrend'),state={...defaultEntryCondition(st),enabled:true,operator:'gt'}
  assert.throws(()=>validateEntryConditions([st],{entryConditions:[state]}),/상태/)
  assert.throws(()=>normalizeRiskSettings({takeProfitPct:0,stopLossPct:2}),/익절/)
  assert.throws(()=>normalizeRiskSettings({takeProfitPct:5,stopLossPct:100}),/손절/)
  assert.throws(()=>normalizeRiskSettings({takeProfitPct:5,stopLossPct:''},{allowIncomplete:false}),/손절/)
  assert.throws(()=>validateExecutionSettings({...options(),start:'2025-02-30',end:date(4)}),/시작일/)
  for(const initialQuantity of ['',0,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>validateExecutionSettings({...options(),initialQuantity},rows([100,100])),/수량/)
  for(const value of ['', ' ', NaN, Infinity]) assert.throws(()=>validateEntryConditions([ma],{entryConditions:[condition('close','gt',value)]}),/기준값/)
  assert.throws(()=>run([100,101],{entryConditions:[{...condition(),left:'short',right:{type:'series',field:'long'}}],takeProfitPct:''}),/익절/)
  assert.throws(()=>runBacktest(rows([100,101]),[{...ma,longPeriod:500}],options({entryConditions:[{...condition(),left:'short',right:{type:'series',field:'long'}}]})),/준비 기간/)
  assert(backtestReadiness(rows([100,101]),[ma],options({initialQuantity:1.5})).some(s=>s.includes('수량')))
 })
