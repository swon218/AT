import test from 'node:test'
import assert from 'node:assert/strict'
import { clearRecoveryUrl, initializePasswordRecovery, passwordResetRedirect, readRecoveryRequest } from '../src/services/passwordRecovery.js'

test('recognizes reset callbacks before the SDK removes the hash', () => {
  assert.equal(readRecoveryRequest('https://atlas.example/?auth=reset-password').requested, true)
  assert.equal(readRecoveryRequest('https://atlas.example/#type=recovery&access_token=test').requested, true)
  assert.equal(readRecoveryRequest('https://atlas.example/#type=signup').requested, false)
  assert.equal(readRecoveryRequest('https://atlas.example/?auth=reset-password#error_code=otp_expired').failed, true)
})

test('redirect contains only the application path and reset marker, never callback tokens', () => {
  assert.equal(passwordResetRedirect('https://atlas.example/?code=secret&tab=account#access_token=secret'), 'https://atlas.example/?auth=reset-password')
  assert.equal(passwordResetRedirect('http://127.0.0.1:5173/'), 'http://127.0.0.1:5173/?auth=reset-password')
})

test('completion removes recovery parameters while preserving unrelated navigation', () => {
  assert.equal(clearRecoveryUrl('https://atlas.example/?tab=lab&auth=reset-password&code=secret#access_token=secret&type=recovery'), '/?tab=lab')
  assert.equal(clearRecoveryUrl('https://atlas.example/?auth=reset-password#error=access_denied&error_code=otp_expired'), '/')
  assert.equal(clearRecoveryUrl('https://atlas.example/?tab=lab#section'), '/?tab=lab#section')
})

const fakeAuth = ({ session = null, initializationError = null, sessionError = null } = {}) => ({
  initialize: async () => ({ error: initializationError }),
  getSession: async () => ({ data: { session }, error: sessionError }),
})
const request = { requested: true, failed: false }
const session = { user: { id: 'test-user' } }

test('valid recovery session enables the form, including a refreshed callback page', async () => {
  assert.equal((await initializePasswordRecovery(fakeAuth({ session }), request)).recovery.status, 'ready')
})

test('missing session and expired callback cannot enable password changes', async () => {
  assert.equal((await initializePasswordRecovery(fakeAuth(), request)).recovery.status, 'error')
  assert.equal((await initializePasswordRecovery(fakeAuth({ session, initializationError: new Error('invalid token') }), request)).recovery.status, 'error')
  assert.equal((await initializePasswordRecovery(fakeAuth({ session, sessionError: new Error('expired session') }), request)).recovery.status, 'error')
})

test('an expired link must not reuse an unrelated existing login session', async () => {
  assert.equal((await initializePasswordRecovery(fakeAuth({ session }), { requested: true, failed: true })).recovery.status, 'error')
})

test('ordinary logins do not open the password reset form', async () => {
  const result = await initializePasswordRecovery(fakeAuth({ session }), { requested: false, failed: false })
  assert.equal(result.recovery, null)
  assert.equal(result.session, session)
})
