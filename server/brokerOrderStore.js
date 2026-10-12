import { createClient } from '@supabase/supabase-js'
import { config } from './config.js'
import { httpError } from './brokerHttp.js'

// Durable reservation: a timeout or process restart must not submit an order twice.
export function createBrokerOrderStore({ client } = {}) {
  let db = client
  const getDb = () => {
    if (!db) {
      if (!config.supabaseUrl || !config.supabaseSecretKey) throw httpError('주문 요청 저장소가 설정되지 않았습니다.', 503)
      db = createClient(config.supabaseUrl, config.supabaseSecretKey, { auth: { persistSession: false, autoRefreshToken: false } })
    }
    return db
  }
  return async ({ userId, broker, requestId, digest }, submit) => {
    const db = getDb(), identity = { user_id: userId, broker, request_id: requestId }
    const { error } = await db.from('broker_order_requests').insert({ ...identity, request_digest: digest, state: 'pending' })
    if (error) {
      if (error.code !== '23505') throw httpError('주문 저장소를 확인해 주세요. BROKERS_SUPABASE.sql 적용이 필요합니다.', 503)
      const { data, error: readError } = await db.from('broker_order_requests').select('request_digest,state,result').match(identity).single()
      if (readError || !data) throw httpError('이전 주문 요청의 상태를 확인할 수 없습니다.', 503)
      if (data.request_digest !== digest) throw httpError('같은 주문 식별자로 다른 주문을 보낼 수 없습니다.', 409)
      if (data.state === 'succeeded') return data.result
      throw httpError('이미 전송했거나 처리 중인 주문입니다. 증권사 주문 내역에서 결과를 확인해 주세요.', 409)
    }
    let result
    try { result = await submit() }
    catch (cause) {
      await db.from('broker_order_requests').update({ state: 'uncertain', updated_at: new Date().toISOString() }).match(identity)
      throw httpError(`주문 결과를 확인해 주세요. 자동 재전송하지 않습니다. ${cause.message}`, cause.statusCode || 502)
    }
    const { error: saveError } = await db.from('broker_order_requests').update({ state: 'succeeded', result, updated_at: new Date().toISOString() }).match(identity)
    if (saveError) throw httpError('증권사에 주문이 접수되었으나 결과 저장에 실패했습니다. 재주문 전에 증권사 주문 내역을 확인해 주세요.', 502)
    return result
  }
}
export const storeBrokerOrder = createBrokerOrderStore()
