import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {usedEvaluationTools,questionDraft} from '../src/utils/evaluationRows.js'
test('display metadata covers exactly actual registered unique tools without assuming common permissions',async()=>{
 const architecture=JSON.parse(await readFile(new URL('../shared/agentArchitecture.json',import.meta.url),'utf8'))
 const catalog=JSON.parse(await readFile(new URL('../shared/agentToolCatalog.json',import.meta.url),'utf8'))
 const tools=catalog.groups.flatMap(group=>group.tools.map(tool=>tool.name))
 assert.equal(new Set(tools).size,tools.length)
 assert.deepEqual(new Set(architecture.agents.slice(1).flatMap(agent=>agent.tools)),new Set(tools))
 assert.equal(architecture.agents.find(agent=>agent.id==='market').tools.includes('resolve_symbol'),false)
})
test('actual calls preserve retry/error states; registered-but-unused tools never appear',()=>{
 const steps=[{seq:1,kind:'model',name:'model',agent:'news',status:'success'},{seq:2,kind:'tool',name:'get_stock_news',agent:'news',status:'started'},{seq:3,kind:'tool',name:'get_stock_news',agent:'news',status:'error',result:{code:'news_auth_error'}},{seq:4,kind:'tool',name:'get_stock_news',agent:'news',status:'success'}]
 assert.deepEqual(usedEvaluationTools(steps).map(row=>[row.seq,row.name,row.status,row.code]),[[2,'get_stock_news','started',undefined],[3,'get_stock_news','error','news_auth_error'],[4,'get_stock_news','success',undefined]])
 assert.deepEqual(usedEvaluationTools([]),[])
})
test('refresh keeps unsaved input and its expected revision rather than replacing it with a late stored value',()=>{
 const draft={text:'수정 중',base:'이전 질문',revision:1},server={revision:2,spec:{question:'다른 창의 질문'}}
 assert.deepEqual(questionDraft(draft,server),draft)
 assert.deepEqual(questionDraft({text:'이전 질문',base:'이전 질문',revision:1},server),{text:'다른 창의 질문',base:'다른 창의 질문',revision:2})
})
