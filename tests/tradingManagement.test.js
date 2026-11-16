import test from 'node:test'
import assert from 'node:assert/strict'
import {tradingConfigDirty,tradingExecutionBlock,tradingExecutionSnapshot,tradingSessionFilter,eligibleTradingSelection,selectTradingDetail} from '../src/utils/tradingManagement.js'
const strategy={id:'s',name:'전략',revision:2,schema_version:2,indicators:[],backtest_settings:{takeProfitPct:5,stopLossPct:3,entryConditions:[],entryMode:'all'}}
const config={code:'005930',spec:{code:'005930',broker:'toss',accountRef:'own',strategyId:'s',strategyRevision:2,quantity:3,quantityMode:'fixed',entryAction:'once'}}
const base={config,sessions:[],strategies:[strategy],connection:{connected:true,status:'connected',expiresAt:200,accounts:[{ref:'own'}]},capability:{supported:true,ordersEnabled:true},flags:{workerEnabled:true,liveEnabled:true},now:100}
test('selection eligibility separates connection, adapter, account, dirty and runtime authority',()=>{
  assert.equal(tradingExecutionBlock(base),'')
  assert.match(tradingExecutionBlock({...base,dirty:true}),/미저장/)
  assert.match(tradingExecutionBlock({...base,evidence:false}),/확인 중/)
  assert.match(tradingExecutionBlock({...base,connection:{...base.connection,connected:false,status:'failed'}}),/확인 실패/)
  assert.match(tradingExecutionBlock({...base,connection:{...base.connection,connected:false,status:'unconfigured'}}),/미등록/)
  assert.match(tradingExecutionBlock({...base,capability:{supported:false,reason:'취소 계약 확인 필요'}}),/취소 계약/)
  assert.match(tradingExecutionBlock({...base,connection:{...base.connection,accounts:[]}}),/계좌/)
  assert.match(tradingExecutionBlock({...base,capability:{...base.capability,ordersEnabled:false}}),/주문 기능/)
  assert.match(tradingExecutionBlock({...base,flags:{...base.flags,workerEnabled:false}}),/worker/)
  assert.match(tradingExecutionBlock({...base,now:200}),/만료/)
  assert.deepEqual(eligibleTradingSelection(['old','one','two'],['two','three']),['two'])
})
test('dirty comparisons normalize input numbers and active execution always presents its immutable snapshot',()=>{
  assert.equal(tradingConfigDirty({...config.spec,quantity:'3'},config),false)
  assert.equal(tradingConfigDirty({...config.spec,quantity:4},config),true)
  const old={...strategy,revision:1,name:'실행 당시 전략'},session={status:'holding',snapshot:{spec:{...config.spec,quantity:1},strategy:old,executionPolicy:{route:'DEFAULT'}}}
  const shown=tradingExecutionSnapshot(config,session,[strategy])
  assert.equal(shown.strategy.name,'실행 당시 전략');assert.equal(shown.spec.quantity,1);assert.equal(shown.applied,true)
  assert.equal(tradingExecutionSnapshot(config,{status:'stopped'},[strategy]).strategy.revision,2)
  assert.equal(tradingExecutionSnapshot({...config,strategySnapshot:{...strategy,name:'저장 당시 이름'}},{status:'stopped'},[]).strategy.name,'저장 당시 이름')
})
test('progress filtering uses execution identities without conflating repeated runs of one symbol',()=>{
  const rows=[{id:'a',code:'005930',status:'holding'},{id:'b',code:'005930',status:'stopped'},{id:'c',code:'005930',status:'completed'}]
  assert.deepEqual(tradingSessionFilter(rows,'active').map(r=>r.id),['a'])
  assert.deepEqual(tradingSessionFilter(rows,'stopped').map(r=>r.id),['b'])
  assert.deepEqual(tradingSessionFilter(rows,'completed').map(r=>r.id),['c'])
  assert.equal(tradingSessionFilter(rows,'all').length,3)
})
test('progress state and records always come from one matching revision source',()=>{
  const session={id:'run',broker:'toss',account_ref:'account',revision:4,state:{position:{quantity:2}}}
  const context={sessions:[session],intents:[{id:'new-order',session_id:'run',cumulative_quantity:2}],events:[{id:'new-event',session_id:'run'}]}
  const stale={sessions:[{...session,revision:3,state:{position:{quantity:1}}}],intents:[{id:'old-order',session_id:'run',cumulative_quantity:1}],events:[{id:'old-event',session_id:'run'}]}
  const ignored=selectTradingDetail(session,context,stale)
  assert.equal(ignored.session.state.position.quantity,2)
  assert.equal(ignored.data,context)
  const updated={...stale,sessions:[{...session,revision:5,state:{position:{quantity:3}}}],intents:[{id:'complete-order',session_id:'run'},{id:'foreign-order',session_id:'different-run'}],events:[{id:'complete-event',session_id:'run'}]}
  const applied=selectTradingDetail(session,context,updated)
  assert.equal(applied.session.revision,5)
  assert.deepEqual(applied.data.intents.map(row=>row.id),['complete-order'])
  assert.deepEqual(applied.data.events.map(row=>row.id),['complete-event'])
  const wrongScope={...updated,sessions:[{...updated.sessions[0],account_ref:'other-account'}]}
  assert.equal(selectTradingDetail(session,context,wrongScope).data,context)
})
