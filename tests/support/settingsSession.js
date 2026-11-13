let owner='fixture-a'
let authDelay=0
export const fixtureOwner=value=>{owner=value}
export const fixtureAuthDelay=value=>{authDelay=value}
export const supabase={
  auth:{getSession:async()=>{if(authDelay)await new Promise(resolve=>setTimeout(resolve,authDelay));return {data:{session:{user:{id:owner},access_token:owner}}}}},
  from:table=>{
    if(table!=='profiles')throw Error('Fixture profiles only')
    let data,who
    const chain={select:()=>chain,eq:(_field,id)=>{who=id;return chain},update:value=>{data=value;return chain},single:async()=>{
      const r=await fetch(`/__fixture/profile?user=${who}`,data?{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{})
      return {data:await r.json()}
    }}
    return chain
  },
}
