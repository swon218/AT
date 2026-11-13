import {createHash,createHmac} from 'node:crypto'
import {httpError} from './brokerHttp.js'
export const BROKER_IDS=['kiwoom','toss','nh','kb']
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function personalAuth(account,broker){
  if(!BROKER_IDS.includes(broker))throw httpError('증권사를 확인해 주세요.',400)
  const c=account?.credentials||{},auth=broker==='toss'?{apiKey:c.tossApiKey,secretKey:c.tossSecretKey}:{appKey:c[`${broker}AppKey`],secretKey:c[`${broker}SecretKey`]}
  if(!account?.user?.id)throw httpError('로그인이 필요합니다.',401)
  if(!account.status?.[`${broker}Configured`]||!(auth.appKey||auth.apiKey)||!auth.secretKey)throw httpError('선택한 증권사의 개인 API를 등록해 주세요.',403)
  return auth
}
export const accountRef=(account,broker,auth,raw)=>createHmac('sha256',auth.secretKey).update(JSON.stringify([account.user.id,broker,auth.appKey||auth.apiKey,raw])).digest('hex').slice(0,32)
export const credentialVersion=(account,broker,auth)=>digest([account.user.id,broker,auth.appKey||auth.apiKey,auth.secretKey])
