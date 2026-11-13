import {createHash} from 'node:crypto'
import {setTimeout as sleep} from 'node:timers/promises'

// Official notice #68, effective 2026-11-12 18:00 KST. ka10075 and
// kt10000..3 are NOT in this set. Separate read/write 5 TPS budgets.
export const SLOW_ACCOUNT_TRS=new Set(['kt00001','kt00002','kt00003','kt00004','kt00005','kt00007','kt00008','kt00009','kt00010','kt00011','kt00012','kt00013','kt00015','kt00016','kt00017','kt00018','kt50020','kt50021','kt50030','kt50031','kt50032','kt50075'])
export function createKiwoomFlow({now=Date.now,pause=(ms,signal)=>sleep(ms,undefined,{signal}),readInterval=210,accountInterval=1050}={}){
  const entries=new Map()
  function entry(auth){
    const key=createHash('sha256').update(`${auth.appKey}\0${auth.secretKey}`).digest('hex')
    if(!entries.has(key))entries.set(key,{read:0,write:0,account:0,cooldown:0,readQueue:Promise.resolve(),writeQueue:Promise.resolve(),pending:0})
    if(entries.size>1000)for(const [id,state]of entries)if(!state.pending&&Math.max(state.read,state.write,state.account,state.cooldown)<now()-60000)entries.delete(id)
    return entries.get(key)
  }
  return {
    async wait(auth,apiId,signal){
      signal?.throwIfAborted()
      const state=entry(auth),group=/^kt(?:1|5)000[0-9]$/.test(apiId)?'write':'read',queued=now()
      if(state.pending>=100)throw Object.assign(new Error('키움 요청이 대기 중입니다.'),{statusCode:429})
      state.pending++
      const job=state[`${group}Queue`].then(async()=>{
        for(;;){
          signal?.throwIfAborted()
          const time=Math.max(now(),state[group],state.cooldown,SLOW_ACCOUNT_TRS.has(apiId)?state.account:0)
          if(time-queued>20000)throw Object.assign(new Error('키움 조회가 대기 중입니다. 잠시 후 다시 시도해 주세요.'),{statusCode:429})
          if(time>now()){await pause(time-now(),signal);continue}
          state[group]=now()+readInterval
          if(SLOW_ACCOUNT_TRS.has(apiId))state.account=now()+accountInterval
          return
        }
      }).finally(()=>{state.pending--})
      state[`${group}Queue`]=job.catch(()=>{})
      if(!signal)return job
      return new Promise((resolve,reject)=>{
        const abort=()=>reject(signal.reason)
        signal.addEventListener('abort',abort,{once:true})
        job.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort))
        if(signal.aborted)abort()
      })
    },
    limited(auth,seconds=2){entry(auth).cooldown=Math.max(entry(auth).cooldown,now()+Math.min(30,Math.max(1,seconds))*1000)},
  }
}
export const kiwoomFlow=createKiwoomFlow()
