import test from 'node:test'
import assert from 'node:assert/strict'
import { config } from './config.js'
import { decryptCredentials, encryptCredentials } from './credentialCrypto.js'
import { getAccountSettings, getAuthenticatedCredentials, updateAccountSettings } from './accountSettings.js'
import { createAccountConnectionHandler } from './accountConnections.js'
import { createAccountConnectionCache } from './accountConnectionCache.js'

const brokerNames = ['kiwoom', 'toss', 'nh', 'kb']
const pairs = Object.fromEntries(brokerNames.flatMap(broker => [
  [broker === 'toss' ? 'tossApiKey' : `${broker}AppKey`, `fixture-invalid-${broker}-key`],
  [`${broker}SecretKey`, `fixture-invalid-${broker}-secret`],
]))

function fixture(credentials = {}) {
  const userId = 'settings-fixture-owner'
  let stored = null, failure = null, writes = 0
  if (Object.keys(credentials).length) {
    const encrypted = encryptCredentials(userId, credentials)
    stored = { user_id: userId, credentials_ciphertext: encrypted.ciphertext,
      credentials_iv: encrypted.iv, credentials_auth_tag: encrypted.authTag,
      ...Object.fromEntries(brokerNames.map(broker => [`${broker}_configured`, Boolean(credentials[broker === 'toss' ? 'tossApiKey' : `${broker}AppKey`] && credentials[`${broker}SecretKey`])])),
      telegram_configured: Boolean(credentials.telegramBotToken) }
  }
  const client = { from(table) {
    assert.equal(table, 'user_integrations')
    let pending
    const query = {
      select: () => query,
      eq: (field, value) => { assert.equal(field, 'user_id'); assert.equal(value, userId); return query },
      maybeSingle: async () => ({ data: stored && { ...stored } }),
      upsert: (value, options) => { assert.equal(options.onConflict, 'user_id'); pending = value; return query },
      single: async () => { if (failure) return { data: null, error: failure }; stored = pending; writes++; return { data: { ...stored } } },
    }
    return query
  } }
  const deps = { client, authenticate: async () => ({ id: userId }) }
  return { userId, deps, raw: () => stored && { ...stored }, writes: () => writes,
    fail: value => { failure = value },
    read: () => stored ? decryptCredentials(userId, { ciphertext: stored.credentials_ciphertext, iv: stored.credentials_iv, authTag: stored.credentials_auth_tag }) : {},
  }
}

async function withTestEncryption(run) {
  const previous = config.credentialEncryptionKey
  config.credentialEncryptionKey = 'a'.repeat(64)
  try { await run() } finally { config.credentialEncryptionKey = previous }
}

test('hidden Telegram and unrelated encrypted values survive broker replacement and deletion', async () => withTestEncryption(async () => {
  const hidden = { telegramBotToken: 'fixture-existing-hidden-token', telegramChatId: 'fixture-legacy-chat', legacySetting: 'fixture-retained' }
  const data = fixture({ ...pairs, ...hidden })
  const response = await updateAccountSettings({ body: { nhSecretKey: 'fixture-replaced-secret', user_id: 'other-user' } }, data.deps)
  assert.deepEqual(Object.fromEntries(Object.keys(hidden).map(key => [key, data.read()[key]])), hidden)
  assert.equal(data.read().nhAppKey, pairs.nhAppKey)
  assert.equal(data.read().nhSecretKey, 'fixture-replaced-secret')
  assert.equal(response.nhConfigured, true)
  for (const broker of brokerNames) {
    const result = await updateAccountSettings({ body: { clearBrokers: [broker] } }, data.deps)
    assert.equal(result[`${broker}Configured`], false)
    assert.equal(data.read()[broker === 'toss' ? 'tossApiKey' : `${broker}AppKey`], undefined)
    assert.equal(data.read()[`${broker}SecretKey`], undefined)
    assert.deepEqual(Object.fromEntries(Object.keys(hidden).map(key => [key, data.read()[key]])), hidden)
    assert.equal(result.telegramConfigured, true)
  }
  assert.equal(JSON.stringify(data.raw()).includes(hidden.telegramBotToken), false)
  assert.equal(JSON.stringify(response).includes('fixture-'), false)
}))

test('configured means successful encrypted storage and survives reload, independently of connection failure', async () => withTestEncryption(async () => {
  const data = fixture()
  const empty = await getAccountSettings({}, data.deps)
  assert.deepEqual(empty, { kiwoomConfigured: false, tossConfigured: false, nhConfigured: false, kbConfigured: false, telegramConfigured: false })
  const saved = await updateAccountSettings({ body: pairs }, data.deps)
  assert.ok(brokerNames.every(broker => saved[`${broker}Configured`] === true))
  // No broker service is a dependency of the save path. Invalid mock keys are
  // deliberately stored; only a separate read-only verification decides connection.
  let probes = 0
  const connection = createAccountConnectionHandler({
    authenticate: request => getAuthenticatedCredentials(request, data.deps),
    cache: createAccountConnectionCache(),
    probe: async () => { probes++; throw new Error('fixture broker authentication failed') },
  })
  for (const broker of brokerNames) assert.equal((await connection({}, broker)).connected, false)
  assert.equal(probes, 4)
  const reloaded = await getAccountSettings({}, { ...data.deps, authenticate: async () => ({ id: data.userId }) })
  assert.deepEqual(reloaded, saved)
  assert.deepEqual(Object.keys(saved).sort(), ['kbConfigured', 'kiwoomConfigured', 'nhConfigured', 'telegramConfigured', 'tossConfigured'])
  assert.ok(!JSON.stringify(saved).match(/fixture|secret|key/i))
}))

test('failed persistence keeps previous encrypted settings and saved metadata; no-op does not erase hidden values', async () => withTestEncryption(async () => {
  const credentials = { ...pairs, telegramBotToken: 'fixture-hidden-preserved' }
  const data = fixture(credentials), previous = data.raw(), status = await getAccountSettings({}, data.deps)
  data.fail(new Error('fixture DB write failed'))
  await assert.rejects(updateAccountSettings({ body: { kiwoomAppKey: 'fixture-unsaved-key' } }, data.deps), /fixture DB write failed/)
  assert.deepEqual(data.raw(), previous)
  assert.deepEqual(data.read(), credentials)
  assert.deepEqual(await getAccountSettings({}, data.deps), status)
  assert.equal(data.writes(), 0)
  await assert.rejects(updateAccountSettings({ body: { telegramBotToken: '', kiwoomAppKey: '   ' } }, data.deps), { statusCode: 400 })
  assert.deepEqual(data.read(), credentials)
}))

test('incomplete stored pairs never become configured and authentication/encryption failures cannot write', async () => withTestEncryption(async () => {
  const data = fixture({ telegramBotToken: 'fixture-existing-token' })
  const incomplete = await updateAccountSettings({ body: { kiwoomAppKey: 'fixture-one-field' } }, data.deps)
  assert.equal(incomplete.kiwoomConfigured, false)
  assert.equal(incomplete.telegramConfigured, true)
  const before = data.raw(), writes = data.writes()
  await assert.rejects(updateAccountSettings({ body: pairs }, { ...data.deps, authenticate: async () => { throw new Error('fixture unauthenticated') } }), /fixture unauthenticated/)
  assert.equal(data.writes(), writes)
  config.credentialEncryptionKey = 'invalid-encryption-key'
  await assert.rejects(updateAccountSettings({ body: pairs }, data.deps), /32-byte Base64 or 64-character hex key/)
  assert.equal(data.writes(), writes)
  assert.deepEqual(data.raw(), before)
}))
