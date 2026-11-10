import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import Fastify from 'fastify'
import { PGlite } from '@electric-sql/pglite'
import { alertAnswer, alertEditor } from './alertAgent.js'
import { registerAgentRoutes } from './agent.js'
import { createKakaoProvider } from './kakaoProvider.js'
import { alertMessage, createAlertWorker, parseAlertQuote } from './alertWorker.js'
import { addAlertDays, alertThreshold, koreanAlertDay } from '../shared/alertRules.js'

const user = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const stock = { code: '005930', name: '삼성전자' }
const today = koreanAlertDay()
const rule = { code: stock.code, kind: 'fall_lte', threshold: 5, expires_on: addAlertDays(today, 7) }
const load = path => readFile(new URL(`../deploy/${path}.sql`, import.meta.url), 'utf8')

async function alertDatabase(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users);
    create function auth.uid() returns uuid language sql as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    insert into auth.users values ('${user}'),('${other}');
  `)
  for (const file of ['WATCHLIST_SUPABASE', 'KAKAO_CONNECTION_SUPABASE', 'ALERT_AGENT_SUPABASE', 'ALERT_AGENT_SUPABASE']) {
    await db.exec(await load(file))
  }
  return db
}

test('legacy alert SQL owns activation, stop, unique observations, send leases, recovery and permission boundaries', async t => {
  const db = await alertDatabase(t)
  const run = async (action, p = {}) => (await db.query('select public.atlas_alert_rpc($1,$2::jsonb) as value',
    [action, JSON.stringify({ user_id: user, ...p })])).rows[0].value
  await db.exec(`insert into public.watchlist_items(user_id,code,name,slot) values ('${user}','005930','삼성전자',1)`)
  await assert.rejects(run('save', { rules: [rule] }), /alert_kakao_required/)
  await db.exec(`
    insert into public.atlas_kakao_links(kakao_id,user_id,status,tokens,scopes,access_until,verified_at)
    values ('111111','${user}','connected','{"ciphertext":"sealed"}','{talk_message}',now()+interval '1 hour',now());
  `)
  await assert.rejects(run('save', { rules: [{ ...rule, code: '000660' }] }), /alert_watchlist_required/)
  await assert.rejects(run('save', { rules: Array(21).fill(rule) }), /alert_invalid/)
  assert.equal(await run('save', { rules: [rule] }), true)
  assert.deepEqual((await run('read', { user_id: other })).rules, [])
  assert.equal((await run('read')).rules[0].status, 'active')
  const operation = randomUUID()
  assert.equal(await run('begin_tick', { operation }), true)
  assert.equal(await run('begin_tick', { operation: randomUUID() }), false)
  const quote = { market: 'KRX', observed_at: new Date(Date.now() - 1000).toISOString(), trade_day: today,
    base_day: addAlertDays(today, -1), price: 950, change_rate: -5 }
  await assert.rejects(run('observe', { operation, code: stock.code, quote: { ...quote, market: 'NXT' } }), /alert_invalid_quote/)
  await run('observe', { operation, code: stock.code, quote: null })
  assert.equal((await run('read')).rules[0].reason, 'quote_unavailable')
  await db.exec('update public.atlas_alert_rules set next_check=now()')
  await run('observe', { operation, code: stock.code, quote })
  await run('observe', { operation, code: stock.code, quote })
  const data = await run('read')
  assert.equal(data.rules[0].status, 'queued')
  assert.equal(data.history.length, 1)
  assert.equal(data.history[0].status, 'queued')
  const id = data.history[0].id
  const args = { operation, event_id: id, kakao_id: '111111', tokens: { ciphertext: 'sealed' }, day_limit: 5 }
  assert.equal(await run('dispatch', { ...args, tokens: { ciphertext: 'old' } }), null)
  assert.equal((await run('dispatch', args)).attempts, 1)
  assert.equal(await run('dispatch', args), null)
  await assert.rejects(run('stop', { code: stock.code }), /alert_dispatch_in_progress/)
  await assert.rejects(db.exec('delete from public.watchlist_items'), /alert_dispatch_in_progress/)
  await assert.rejects(db.exec("update public.atlas_kakao_links set status='reconnect'"), /alert_dispatch_in_progress/)
  // Simulate a process lost after the request was recorded. No resend on recovery.
  await db.exec("update public.atlas_alert_events set lease_until=now()-interval '1 second'")
  await db.exec("update public.atlas_alert_worker set lease_until=now()-interval '1 second',next_tick=now()")
  const recovered = randomUUID()
  assert.equal(await run('begin_tick', { operation: recovered }), true)
  assert.equal((await run('read')).history[0].status, 'unknown')
  assert.deepEqual(await run('queue', { operation: recovered }), [])
  assert.equal(await run('finish', { ...args, result: 'sent' }), false)
  await run('save', { rules: [rule] })
  await db.exec('delete from public.watchlist_items')
  assert.equal((await run('read')).rules.length, 0)
  await db.exec(`insert into public.watchlist_items(user_id,code,name,slot) values ('${user}','005930','삼성전자',1)`)
  assert.equal((await run('read')).rules[0].status, 'stopped')
  await run('resume', { code: stock.code })
  await db.exec("update public.atlas_kakao_links set scopes='{}'")
  assert.equal((await run('read')).rules[0].reason, 'kakao_required')
  await assert.rejects(run('resume', { code: stock.code }), /alert_kakao_required/)
  await db.exec('set role authenticated')
  await assert.rejects(run('read'), { code: '42501' })
  await assert.rejects(db.exec('select * from public.atlas_alert_events'), { code: '42501' })
})

test('v2 migrates sent history and isolates rule versions, pending deliveries, owner writes and retries', async t => {
  const db = await alertDatabase(t)
  const legacy = randomUUID(), snapshot = randomUUID(), orphan = randomUUID()
  await db.exec(`
    insert into public.watchlist_items(user_id,code,name,slot) values ('${user}','005930','삼성전자',1),('${other}','005930','삼성전자',1);
    insert into public.atlas_kakao_links(kakao_id,user_id,status,tokens,scopes,access_until,verified_at)
      values ('111111','${user}','connected','{"ciphertext":"sealed"}','{talk_message}',now()+interval '1 hour',now());
    insert into public.atlas_alert_rules(user_id,code,version,kakao_id,kind,threshold,expires_on,status)
      values ('${user}','005930','${legacy}','111111','price_gte',197500,'${rule.expires_on}','sent');
    insert into public.atlas_alert_events(id,user_id,code,name,version,kind,threshold,observed_at,trade_day,base_day,market,price,change_rate,status,attempts,finished_at)
      values ('${snapshot}','${user}','005930','삼성전자','${legacy}','price_gte',197500,now(),'${today}','${addAlertDays(today, -1)}','KRX',197500,1,'sent',1,now()),
      ('${orphan}','${user}','000660','SK하이닉스',gen_random_uuid(),'price_gte',100000,now(),'${today}','${addAlertDays(today, -1)}','KRX',100000,1,'sent',1,now());
    insert into public.atlas_alert_attempts(event_id,attempt,result) values ('${snapshot}',1,'sent');
  `)
  await db.exec(await load('ALERT_RULES_V2_SUPABASE'))
  await db.exec(await load('ALERT_RULES_V2_SUPABASE'))
  const run = async (action, p = {}) => (await db.query('select public.atlas_alert_rpc_v2($1,$2::jsonb) as value',
    [action, JSON.stringify({ user_id: user, ...p })])).rows[0].value
  const read = () => run('read')
  const change = (mutation, p) => run('mutate', { mutation, operation: randomUUID(), ...p })
  const ref = row => ({ rule_id: row.rule_id, version: row.version })
  const saved = async id => (await read()).rules.find(row => row.rule_id === id)
  const at = (kind, threshold) => ({ ...rule, kind, threshold })
  const before = await read()
  const migrated = before.rules[0]
  assert.equal(before.ruleManagement, true)
  assert.equal(migrated.status, 'sent')
  assert.equal(migrated.version, legacy)
  assert.equal(before.history.find(event => event.id === snapshot).rule_id, migrated.rule_id)
  assert.ok(before.history.find(event => event.id === orphan).rule_id)
  assert.equal((await db.query('select result from public.atlas_alert_attempts')).rows[0].result, 'sent')
  assert.deepEqual((await run('read', { user_id: other })).history, [])
  await assert.rejects(change('cancel', { user_id: other, ...ref(migrated) }), /alert_version_conflict/)
  await assert.rejects(change('update', { ...ref(migrated), rule: at('price_gte', 197600) }), /alert_invalid_state/)

  const create = { mutation: 'create', operation: randomUUID(), rules: [at('price_gte', 197600), at('price_lte', 195000)] }
  assert.equal(await run('mutate', create), true)
  assert.equal(await run('mutation_replay', create), true)
  assert.equal(await run('mutate', create), true)
  await assert.rejects(run('mutate', { ...create, rules: [rule] }), /alert_request_conflict/)
  await assert.rejects(change('create', { rules: [at('price_lte', 195000)] }), /alert_duplicate_condition/)
  const initial = await read()
  assert.equal(initial.rules.length, 3)
  const up = initial.rules.find(row => row.threshold === 197600)
  const down = initial.rules.find(row => row.threshold === 195000)
  const operation = randomUUID()
  await run('begin_tick', { operation })
  assert.deepEqual(await run('symbols', { operation }), ['005930'])
  const observe = async price => {
    await db.exec('update public.atlas_alert_rules set next_check=now()')
    return run('observe', { operation, code: stock.code, quote: { market: 'KRX', observed_at: new Date(Date.now() - 1000).toISOString(),
      trade_day: today, base_day: addAlertDays(today, -1), price, change_rate: 1 } })
  }
  const delivery = event_id => ({ operation, event_id, kakao_id: '111111', tokens: { ciphertext: 'sealed' }, day_limit: 10 })
  const queue = async id => (await read()).history.find(event => event.rule_id === id && event.status === 'queued')
  await observe(197600)
  await observe(197600)
  const first = await queue(up.rule_id)
  assert.equal((await read()).history.filter(event => event.rule_id === up.rule_id).length, 1)
  assert.equal((await saved(down.rule_id)).status, 'active')
  assert.equal(await change('update', { ...ref(up), rule: at('price_gte', 197600) }), true)
  assert.equal((await saved(up.rule_id)).version, up.version)
  assert.equal((await queue(up.rule_id)).id, first.id)
  await change('update', { ...ref(up), rule: at('price_gte', 198000) })
  assert.equal(await run('dispatch', delivery(first.id)), null)
  await assert.rejects(change('cancel', ref(up)), /alert_version_conflict/)
  await observe(197600)
  assert.equal(await queue(up.rule_id), undefined)
  await observe(198000)
  const claimed = delivery((await queue(up.rule_id)).id)
  assert.equal((await run('dispatch', claimed)).attempts, 1)
  assert.equal((await saved(up.rule_id)).status, 'sending')
  await assert.rejects(change('cancel', ref(await saved(up.rule_id))), /alert_dispatch_in_progress/)
  await assert.rejects(change('update', { ...ref(await saved(up.rule_id)), rule: at('price_gte', 200000) }), /alert_dispatch_in_progress/)
  await run('finish', { ...claimed, result: 'sent' })
  assert.equal((await saved(down.rule_id)).status, 'active')
  await observe(190000)
  const pendingDown = await queue(down.rule_id)
  assert.equal((await saved(up.rule_id)).status, 'sent')
  assert.equal((await saved(down.rule_id)).status, 'queued')
  await change('cancel', ref(down))
  assert.equal(await run('dispatch', delivery(pendingDown.id)), null)
  assert.equal((await saved(down.rule_id)).status, 'canceled')
  await observe(200000)
  assert.equal(await queue(up.rule_id), undefined)
  assert.equal((await read()).history.find(event => event.id === snapshot).threshold, 197500)

  const restart = { mutation: 'restart', operation: randomUUID(), ...ref(migrated), rule: at('price_gte', 197600) }
  await run('mutate', restart)
  const restarted = await saved(migrated.rule_id)
  assert.notEqual(restarted.version, legacy)
  await run('mutate', restart)
  assert.equal((await saved(migrated.rule_id)).version, restarted.version)
  await observe(197500)
  assert.equal(await queue(migrated.rule_id), undefined)
  await observe(197600)
  assert.equal((await queue(migrated.rule_id)).threshold, 197600)
  await change('restart', { ...ref(await saved(down.rule_id)), rule: at('price_lte', 195000) })
  await db.exec(`delete from public.watchlist_items where user_id='${user}'`)
  assert.deepEqual((await read()).rules, [])
  assert.deepEqual(await run('queue', { operation }), [])
  await db.exec(`insert into public.watchlist_items(user_id,code,name,slot) values ('${user}','005930','삼성전자',1)`)
  assert.equal((await read()).rules.filter(row => row.status === 'stopped').length, 2)
  await change('create', { rules: Array.from({ length: 7 }, (_, i) => at('price_gte', 200000 + i)) })
  await assert.rejects(change('create', { rules: [at('price_gte', 300000)] }), /alert_rule_limit/)
  await db.exec("update public.atlas_kakao_links set scopes='{}'")
  assert.equal((await read()).rules.filter(row => row.status === 'stopped').length, 9)
  await run('end_tick', { operation })
  await db.exec('set role authenticated')
  await assert.rejects(run('read'), { code: '42501' })
  await db.exec('reset role; set role service_role')
  await assert.rejects(db.exec("select public.atlas_alert_rpc_v1('read','{}')"), { code: '42501' })
  await assert.rejects(db.exec('select * from public.atlas_alert_mutations'), { code: '42501' })
  assert.equal((await read()).ruleManagement, true)
})

test('scope consent checks exact identity, and only the official memo endpoint sends', async () => {
  const requests = []
  const provider = createKakaoProvider({ kakaoRestKey: 'fixture' }, async (url, options) => {
    requests.push({ url: new URL(url), options })
    return new Response(url.includes('/scopes')
      ? '{"id":9007199254740993,"scopes":[{"id":"talk_message","using":true,"agreed":true}]}'
      : '{"result_code":0}')
  })
  assert.equal(new URL(provider.authorize('state', false, true)).searchParams.get('scope'), 'talk_message')
  assert.equal(await provider.messageScope('access', '9007199254740993'), true)
  await assert.rejects(provider.messageScope('access', '9007199254740992'), { kind: 'unavailable' })
  const template = alertMessage({ ...rule, ...stock, price: 950, change_rate: -5, observed_at: '2026-11-10T00:30:00Z' },
    'https://at-chi-six.vercel.app/?agent=alerts#alert-history')
  assert.match(template.text, /전일 대비 5% 이상 하락/)
  assert.match(template.text, /KRX/)
  await provider.sendMemo('access', template)
  assert.equal(requests.at(-1).url.pathname, '/v2/api/talk/memo/default/send')
  assert.deepEqual(JSON.parse(requests.at(-1).options.body.get('template_object')), template)
})

test('prices and changes come from the same dated KRX tick; stale, previous-day, closed and incomplete quotes fail closed', () => {
  const session = { date: '2026-11-10', previous: '2026-11-09', open: '2026-11-10T00:00:00Z', close: '2026-11-10T06:30:00Z' }
  const now = Date.parse('2026-11-10T01:00:45Z')
  const raw = { cntr_tm: '20261110100000', cur_prc: '-950', pred_pre: '50', pred_pre_sig: '5' }
  const parse = (row = raw, at = now) => parseAlertQuote({ return_code: 0, stk_cd: stock.code, stk_tic_chart_qry: [row] }, stock.code, session, at)
  assert.equal(parse().change_rate, -5)
  assert.equal(parse({ ...raw, pred_pre: '0', pred_pre_sig: '3' }).change_rate, 0)
  for (const row of [{ ...raw, cntr_tm: '20261109100000' }, { ...raw, cntr_tm: '20261110095900' },
    { ...raw, cntr_tm: '20261110100100' }, { ...raw, pred_pre: '' }, { ...raw, cur_prc: '0' }]) {
    assert.equal(parse(row), null)
  }
  assert.equal(parse(raw, Date.parse(session.close)), null)
  assert.equal(alertThreshold('fall_lte', '0'), 0)
  assert.equal(alertThreshold('price_gte', '0'), null)
  assert.equal(alertThreshold('rise_gte', '1e2'), null)
  assert.equal(alertThreshold('fall_lte', '-5'), null)
})

test('worker never retries an ambiguous provider response, while confirmed quota rejection is eligible', async () => {
  const now = Date.parse('2026-11-10T01:00:45Z')
  const session = { date: '2026-11-10', previous: '2026-11-09', open: '2026-11-10T00:00:00Z', close: '2026-11-10T06:30:00Z' }
  for (const [failure, expected] of [['unavailable', 'unknown'], ['quota', 'retry']]) {
    let posted = 0, result
    const tick = createAlertWorker({
      settings: { enabled: true, dailyLimit: 10, historyUrl: 'https://at-chi-six.vercel.app/?agent=alerts#alert-history' },
      calendar: async () => session, now: () => now, pause: async () => {},
      store: async (action, p) => {
        if (action === 'begin_tick') return true
        if (action === 'scope_due' || action === 'symbols') return []
        if (action === 'queue') return [{ id: randomUUID(), user_id: user }]
        if (action === 'dispatch') return { ...rule, ...stock, price: 950, change_rate: -5,
          observed_at: new Date(now).toISOString(), lease_until: new Date(now + 45_000).toISOString() }
        if (action === 'finish') result = p.result
      },
      access: async () => ({ status: 'ready', link: { kakao_id: '111111', tokens: {} } }),
      decrypt: () => ({ access: 'mock' }),
      provider: { messageScope: async () => true, sendMemo: async () => {
        posted++; throw Object.assign(new Error('fixture'), { kind: failure })
      } },
    })
    await tick()
    assert.equal(result, expected)
    assert.equal(posted, 1)
  }
})

test('AI drafts recheck membership, preserve room and revision, and never activate; alert API authenticates and validates bounds', async t => {
  const roomId = randomUUID(), requestId = randomUUID(), revision = randomUUID()
  const editor = alertEditor({ revision, draft: { ...rule, id: randomUUID() } }, [stock])
  const actions = []
  const store = async (action, p) => {
    actions.push(action)
    assert.equal(p.user_id, user)
    if (action === 'mutation_replay') return false
    return { watchlist: [stock], rules: [], history: [], kakao: 'ready' }
  }
  const answer = await alertAnswer({ kind: 'draft', edit: true, rule: { ...rule, threshold: 7 } },
    { store, userId: user, roomId, requestId, editor })
  assert.equal(answer.alertDraft.roomId, roomId)
  assert.equal(answer.alertDraft.baseRevision, revision)
  assert.equal(answer.alertDraft.id, editor.draft.id)
  assert.equal(answer.alertDraft.threshold, 7)
  assert.deepEqual(actions, ['read'])
  const outside = await alertAnswer({ kind: 'draft', rule: { ...rule, code: '000660' } },
    { store, userId: user, roomId, requestId, editor })
  assert.equal(outside.alertDraft, undefined)
  const savedRule = { ...rule, rule_id: randomUUID(), version: randomUUID(), status: 'active' }
  const readSaved = async action => {
    assert.equal(action, 'read')
    return { watchlist: [stock], rules: [savedRule], history: [] }
  }
  const context = { store: readSaved, userId: user, roomId, requestId, editor }
  const changeDraft = { kind: 'draft', rule_id: savedRule.rule_id, version: savedRule.version, rule: { ...rule, threshold: 7 } }
  assert.equal((await alertAnswer(changeDraft, context)).alertDraft.rule_id, savedRule.rule_id)
  assert.equal((await alertAnswer({ ...changeDraft, version: randomUUID() }, context)).alertDraft, undefined)
  assert.equal((await alertAnswer({ kind: 'draft', rule }, context)).alertDraft.rule_id, undefined)
  const app = Fastify()
  t.after(() => app.close())
  registerAgentRoutes(app, { authenticate: async () => user, alertStore: store, alertOptions: {
    settings: { enabled: false }, access: async () => { throw new Error('gate should run before Kakao access') },
  } })
  const url = '/api/agent/alerts', headers = { authorization: 'Bearer fixture' }
  assert.equal((await app.inject({ url })).statusCode, 401)
  assert.equal((await app.inject({ url, headers })).json().watchlist[0].code, stock.code)
  const post = payload => app.inject({ method: 'POST', url, headers, payload: { operation: randomUUID(), ...payload } })
  assert.equal((await post({ action: 'save', rules: [rule] })).statusCode, 400)
  assert.equal((await post({ action: 'create', rules: Array(21).fill(rule) })).statusCode, 400)
  assert.equal((await post({ action: 'create', rules: [rule] })).json().error, 'alert_disabled')
  assert.ok(!actions.includes('mutate'))
})
