const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const fail=(code,statusCode=400)=>Object.assign(new Error(code),{statusCode})
const only=(body,keys)=>body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).every(key=>keys.includes(key))

export function boundedProductionResult(result) {
  const {agent_results,...value}=result
  if(Buffer.byteLength(JSON.stringify(value))>150000) {
    value.steps=(value.steps||[]).map(({seq,agent,kind,name,status,arguments:args,result:output,elapsed_ms})=>({seq,agent,kind,name,status,arguments:args,elapsed_ms,
      result:Object.fromEntries(['code','status','count','agents','usage_status','usage_total'].filter(key=>output?.[key]!==undefined).map(key=>[key,output[key]]))}))
    value.trace_truncated=true
  }
  if(Buffer.byteLength(JSON.stringify(value))>170000)throw fail('eval_result_too_large')
  return value
}

export function registerProductionEvaluation(app,{store,guarded,id}) {
  const runner=()=>{if(!app.hasDecorator('agentProductionRunner'))throw fail('eval_runtime_not_ready',503);return app.agentProductionRunner}
  app.get('/api/agent/admin/workspace',guarded(async(req,owner)=>{
    if(!only(req.query,['view','page'])||!['all','executed'].includes(req.query.view||'all')||!/^\d{1,2}$/.test(String(req.query.page||1))||Number(req.query.page||1)<1||Number(req.query.page||1)>30)throw fail('eval_invalid')
    return store('workspace',owner,{view:req.query.view||'all',page:Number(req.query.page||1)})
  }))
  app.put('/api/agent/admin/questions/:id',{bodyLimit:26000},guarded((req,owner)=>{
    const b=req.body
    if(!only(b,['revision','question'])||!Number.isInteger(b.revision)||b.revision<0||typeof b.question!=='string'||b.question.length>6000)throw fail('eval_invalid')
    return store('save_question',owner,{id:id(req),...b})
  }))
  app.get('/api/agent/admin/questions/:id/history',guarded(async(req,owner)=>{
    if(!only(req.query,['before']))throw fail('eval_invalid')
    let before
    if(req.query.before) {
      try {before=JSON.parse(Buffer.from(req.query.before,'base64url').toString())}catch{throw fail('eval_invalid')}
      if(!only(before,['at','id'])||!uuid.test(before.id)||typeof before.at!=='string'||before.at.length>40||!Number.isFinite(Date.parse(before.at)))throw fail('eval_invalid')
    }
    const data=await store('question_history',owner,{id:id(req),...(before?{before}:{})})
    return {...data,next:data.next?Buffer.from(JSON.stringify(data.next)).toString('base64url'):null}
  }))
  app.post('/api/agent/admin/questions/:id/execute',{bodyLimit:26000},guarded(async(req,owner,reply)=>{
    const b=req.body
    if(!only(b,['id','revision','question','paidConfirmed'])||!uuid.test(b.id)||!Number.isInteger(b.revision)||b.revision<1||typeof b.question!=='string'||!b.question.trim()||b.question.length>6000||b.paidConfirmed!==true)throw fail('eval_invalid')
    const request={...b,case_id:id(req)}
    const existing=await store('production_lookup',owner,request)
    if(existing)return reply.code(202).send(existing)
    const runtime=await runner().ready(owner)
    const accepted=await store('start_production',owner,{...request,runtime})
    if(accepted.created) {
      const lease={id:accepted.id,lease:accepted.lease}
      void (async()=>{
        try {
          const result=await runner().run({id:accepted.id,owner,question:b.question,
            isActive:()=>store('production_active',owner,lease),
            onStep:event=>store('production_step',owner,{...lease,event})})
          await store('finish_production',owner,{...lease,state:result.status==='failed'?'failed':'completed',result:boundedProductionResult(result)})
        }catch {
          // Never retry a potentially paid model call. Keep previously received trace.
          await store('finish_production',owner,{...lease,state:'failed',result:{error_code:'execution_interrupted',usage:{status:'unknown'}}}).catch(()=>{})
        }
      })()
    }
    return reply.code(202).send({id:accepted.id,created:accepted.created})
  }))
  app.post('/api/agent/admin/items/:id/note',{bodyLimit:12000},guarded((req,owner)=>{
    const b=req.body
    if(!only(b,['version','text'])||!Number.isInteger(b.version)||b.version<0||typeof b.text!=='string'||b.text.length>2000)throw fail('eval_invalid')
    return store('save_note',owner,{id:id(req),...b})
  }))
}
