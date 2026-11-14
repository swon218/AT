import test from 'node:test'
import assert from 'node:assert/strict'
import {createIndicatorConfig} from '../src/utils/indicators.js'
import {emptyStrategyDraft,removeDraftIndicator,resetStrategyDraft,strategyFingerprint} from '../src/utils/strategyDraft.js'

const execution = {symbol:'005930',start:'2025-01-01',end:'2025-12-31',initialQuantity:3,quantityMode:'reinvest'}
const edited = () => ({...emptyStrategyDraft('owner'),strategyName:'나의 전략',selected:{id:'saved',revision:4},indicatorConfigs:[createIndicatorConfig('ma')],backtestSettings:{...emptyStrategyDraft('owner').backtestSettings,...execution,entryConditions:[{indicatorId:'ma',enabled:true,left:'short',operator:'gt',right:{type:'series',field:'long'}}],takeProfitPct:5,stopLossPct:2}})

test('execution settings never mark the reusable strategy definition dirty',()=>{
  const before=edited(),after={...before,backtestSettings:{...before.backtestSettings,start:'2024-01-01',end:'2024-12-31',symbol:'000660',initialQuantity:50,quantityMode:'fixed'}}
  assert.equal(strategyFingerprint(before),strategyFingerprint(after))
  assert.notEqual(strategyFingerprint(before),strategyFingerprint({...before,backtestSettings:{...before.backtestSettings,takeProfitPct:8}}))
})

test('new strategy clears definition and selection but preserves the entire execution workspace',()=>{
  const before=edited(),next=resetStrategyDraft(before)
  assert.equal(next.selected,null);assert.equal(next.strategyName,'');assert.deepEqual(next.indicatorConfigs,[])
  assert.deepEqual(next.backtestSettings.entryConditions,[]);assert.equal(next.backtestSettings.takeProfitPct,'');assert.equal(next.backtestSettings.stopLossPct,'')
  for(const [key,value] of Object.entries(execution)) assert.equal(next.backtestSettings[key],value)
  assert.equal(next.resetVersion,before.resetVersion+1)
  assert.equal(resetStrategyDraft(next),next)
  assert.equal(before.selected.id,'saved')
})

test('full workspace reset preserves symbol and never mutates the other tab draft or saved data',()=>{
  const lab=edited(),order=edited(),snapshot=JSON.stringify(order),next=resetStrategyDraft(lab,true)
  assert.equal(next.backtestSettings.symbol,'005930');assert.equal(next.backtestSettings.start,'');assert.equal(next.backtestSettings.end,'');assert.equal(next.backtestSettings.initialQuantity,'');assert.equal(next.backtestSettings.quantityMode,'fixed')
  assert.equal(next.selected,null);assert.equal(next.resetVersion,1);assert.equal(JSON.stringify(order),snapshot)
  assert.equal(resetStrategyDraft(next,true),next)
})

test('indicator deletion removes its own conditions and comparison references but preserves unrelated rules',()=>{
  const before=edited();before.indicatorConfigs.push(createIndicatorConfig('bollinger'),createIndicatorConfig('rsi'))
  before.backtestSettings.entryConditions.push({indicatorId:'bollinger',enabled:true,left:'close',operator:'gte',right:{type:'series',indicatorId:'ma',field:'short'}},{indicatorId:'rsi',enabled:true,left:'rsi',operator:'lte',right:{type:'constant',value:30}})
  const next=removeDraftIndicator(before,'ma')
  assert.deepEqual(next.indicatorConfigs.map(c=>c.id),['bollinger','rsi']);assert.deepEqual(next.backtestSettings.entryConditions.map(c=>c.indicatorId),['rsi'])
  assert.equal(before.backtestSettings.entryConditions.length,3);assert.equal(next.backtestSettings.initialQuantity,3)
})
