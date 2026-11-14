import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {usedEvaluationTools,questionDraft,evaluationSelection,toggleEvaluationSelection,withoutEvaluationQuestions,evaluationMessage} from '../src/utils/evaluationRows.js'
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
test('question selection keeps immutable identity across numbering changes and pages',()=>{
 const first={id:'question-a',revision:2,display_number:1},second={id:'question-b',revision:4,display_number:12}
 let selected=toggleEvaluationSelection([],first,true)
 selected=toggleEvaluationSelection(selected,second,true)
 assert.deepEqual(selected,[evaluationSelection(first),evaluationSelection(second)])
 // A refreshed row may have a different number; unselecting still targets the same ID.
 assert.deepEqual(toggleEvaluationSelection(selected,{...second,display_number:11},false),[evaluationSelection(first)])
 assert.equal(toggleEvaluationSelection(selected,second,true).length,2)
 // The expected revision remains a snapshot until an explicit re-selection.
 assert.equal(selected[1].revision,4)
 assert.deepEqual(toggleEvaluationSelection(selected,{...second,revision:5},true).at(-1),{id:'question-b',revision:5,display_number:12})
})
test('deleting questions clears only their input and notes while keeping unrelated drafts',()=>{
 const inputs={a:{text:'first'},b:{text:'second'}},notes={itemA:{questionId:'a',text:'unsaved a'},itemB:{questionId:'b',text:'unsaved b'}}
 assert.deepEqual(withoutEvaluationQuestions(inputs,['a']),{b:inputs.b})
 assert.deepEqual(withoutEvaluationQuestions(notes,['a']),{itemB:notes.itemB})
 assert.deepEqual(withoutEvaluationQuestions(notes,[]),notes)
})
test('deletion failures expose safe actionable messages rather than internal database details',()=>{
 assert.match(evaluationMessage({code:'eval_delete_conflict',message:'internal sql'}),/다른 곳에서 변경/)
 assert.match(evaluationMessage({code:'eval_delete_busy',message:'internal sql'}),/실행 중/)
 assert.doesNotMatch(evaluationMessage({code:'eval_delete_busy',message:'internal sql'}),/internal/)
})
