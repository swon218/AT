export const fixtureUsers={a:'11111111-1111-4111-8111-111111111111',b:'22222222-2222-4222-8222-222222222222'}
let current={user:'a',scenario:'holding'}
export function setPurchaseFixtureAuth(next){current={...current,...next}}
export const initialRecoveryRequest={requested:false}
export const isSupabaseConfigured=true
export const supabase={auth:{getSession:async()=>({data:{session:current.user==='guest'?null:{
 user:{id:fixtureUsers[current.user]},access_token:`purchase-fixture:${current.user}:${current.scenario}`,
}}})}}
