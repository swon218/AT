export function verdict(item) {
  if(item.state==='queued'||item.state==='running')return 'pending'
  if(item.state==='canceled')return 'canceled'
  if(['failed','interrupted'].includes(item.state)||item.checks?.some(c=>c.status==='fail'))return 'fail'
  if(item.review?.status==='fail')return 'fail'
  if(item.review?.status==='pass')return 'pass'
  return item.grade==='pass'?'pass':'review'
}
export function summarize(items) {
  const counts={total:items.length,pass:0,fail:0,review:0,pending:0,canceled:0,critical:0,usd:0,unknown:0,ms:0,calls:0,input:0,output:0,timed:0,categories:{}}
  for(const item of items){
    counts[verdict(item)]++
    if(verdict(item)==='fail'){const category=item.review?.status==='fail'?item.review.category:'미분류 · 상세 확인';counts.categories[category]=(counts.categories[category]||0)+1}
    if(item.checks?.some(c=>c.critical&&c.status==='fail'))counts.critical++
    if(item.usage?.status==='unknown')counts.unknown++
    counts.usd+=Number(item.usage?.budget_usd||0)
    counts.calls+=Number(item.usage?.model_calls||0)
    counts.input+=Number(item.usage?.input_tokens||0); counts.output+=Number(item.usage?.output_tokens||0)
    if(item.elapsed_ms!=null){counts.ms+=item.elapsed_ms;counts.timed++}
  }
  return counts
}
export function compareRuns(a,b) {
  const key=i=>`${i.case_id}:${i.repetition}`
  const left=new Map(a.items.map(i=>[key(i),i])); const right=new Map(b.items.map(i=>[key(i),i]))
  return [...new Set([...left.keys(),...right.keys()])].map(k=>{
    const x=left.get(k),y=right.get(k)
    const firstMetadata=x?.metadata,lastMetadata=y?.metadata
    const stableSettings=value=>JSON.stringify(Object.entries(value||{}).sort(([a],[b])=>a.localeCompare(b)))
    const sameInputs=firstMetadata?.data_hash&&firstMetadata.data_hash===lastMetadata?.data_hash
      &&['dataset','model','now'].every(field=>firstMetadata[field]&&firstMetadata[field]===lastMetadata[field])
      &&firstMetadata.settings&&lastMetadata.settings&&stableSettings(firstMetadata.settings)===stableSettings(lastMetadata.settings)
    const comparable=x&&y&&x.revision===y.revision&&a.run.mode===b.run.mode
      &&((x.fingerprint&&x.fingerprint===y.fingerprint)||sameInputs)
    const first=x&&verdict(x),last=y&&verdict(y)
    let change='조건이 달라 직접 비교 불가'
    if(comparable){
      change=first==='pass'&&last==='pass'?'계속 통과':first==='fail'&&last==='pass'?'실패 → 통과':first==='pass'&&last==='fail'?'통과 → 실패':first==='fail'&&last==='fail'?'계속 실패':'검토·미실행 항목 포함'
    }
    return {key:k,title:y?.title||x?.title,first,last,change,
      firstArchitecture:firstMetadata?.architecture||'구조 미기록',lastArchitecture:lastMetadata?.architecture||'구조 미기록'}
  })
}
