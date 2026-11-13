import test from 'node:test'
import assert from 'node:assert/strict'
import { accountConnectionCache } from './accountConnectionCache.js'
import { invalidateCredentials, subscribeCredentialInvalidation } from './credentialInvalidation.js'

test('committed lifecycle invalidates only the selected owner/broker and contains no credential payload', async () => {
  const owner = 'invalidation-fixture-owner', other = 'invalidation-fixture-other'
  const first = await accountConnectionCache.check(owner, 'kiwoom', 'fixture-v1', async () => true)
  const sameOwner = await accountConnectionCache.check(owner, 'nh', 'fixture-v1', async () => true)
  const otherOwner = await accountConnectionCache.check(other, 'kiwoom', 'fixture-v1', async () => true)
  const events = []
  const stopFailure = subscribeCredentialInvalidation(() => { throw new Error('private fixture listener details') })
  const stop = subscribeCredentialInvalidation(event => events.push(event))
  try {
    invalidateCredentials(owner, ['kiwoom', 'kiwoom', 'invalid'])
    assert.equal(first.current(), false)
    assert.equal(sameOwner.current(), true)
    assert.equal(otherOwner.current(), true)
    assert.deepEqual(events, [{ userId: owner, brokers: ['kiwoom'] }])
    assert.ok(Object.isFrozen(events[0]) && Object.isFrozen(events[0].brokers))
    stop()
    invalidateCredentials(owner, ['nh'])
    assert.equal(events.length, 1)
    assert.equal(sameOwner.current(), false)
  } finally {
    stop(); stopFailure()
    accountConnectionCache.invalidate(owner, ['kiwoom', 'nh'])
    accountConnectionCache.invalidate(other, ['kiwoom'])
  }
})
