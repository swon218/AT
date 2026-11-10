import test from 'node:test'
import assert from 'node:assert/strict'
import {agentSourceLabel,agentSourceTime} from '../src/utils/agentSources.js'

test('source presentation does not turn market quotes, titles or financials into completed daily bars',()=>{
 assert.equal(agentSourceLabel({scope:'quote'}).includes('공급자 시각 확인 불가'),true)
 assert.equal(agentSourceTime({scope:'quote',queried_at:'2026-11-11T01:00:00Z'}),'기준 확인 불가 · 조회 2026-11-11T01:00:00Z')
 assert.match(agentSourceLabel({scope:'fundamental',data_kind:'disclosures',body_available:false}),/제목·목록/)
 assert.match(agentSourceLabel({scope:'fundamental',data_kind:'financials',financial_scope:'OFS',basis:'single_quarter',currency:'USD'}),/별도.*단일분기.*USD/)
 assert.match(agentSourceTime({scope:'fundamental',end:'2025-12-31',filed_on:'2026-03-20',collected_at:'2026-04-01',queried_at:'2026-11-11',stale:true}),/보고기간 말.*공시.*저장 갱신.*조회.*만료 자료/)
 assert.equal(agentSourceLabel({id:'r_123'}),'확정 일봉')
})
