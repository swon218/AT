import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { bindChartTheme } from '../src/utils/chartTheme.js'

const bootstrap = await readFile(new URL('../public/theme-init.js', import.meta.url), 'utf8')
function browser(saved, blocked = false) {
  const stored = new Map(saved === undefined ? [] : [['atlas.theme.v1', saved]])
  const events = new Map(), meta = { content: '' }, root = { dataset: {}, style: {} }
  const window = { localStorage: { getItem: key => { if (blocked) throw new Error('blocked'); return stored.get(key) ?? null },
    setItem: (key, value) => { if (blocked) throw new Error('quota'); stored.set(key, value) } }, addEventListener: (type, listener) => { events.set(type, [...(events.get(type) || []), listener]) } }
  const document = { documentElement: root, querySelector: () => meta }
  const context = { window, document }
  runInNewContext(bootstrap, context)
  return { store: window.atlasTheme, root, meta, stored, events, rerun: () => runInNewContext(bootstrap, context),
    event: event => events.get('storage').forEach(listener => listener(event)) }
}

test('first visit, invalid values and unavailable storage safely start in dark mode', () => {
  for (const value of [undefined, '', 'Light', 'null', '{}', '<script>']) assert.equal(browser(value).store.getSnapshot(), 'dark')
  assert.equal(browser('light', true).store.getSnapshot(), 'dark')
})

test('blocking bootstrap restores light before app mount and applies browser chrome metadata', () => {
  const { root, meta, store } = browser('light')
  assert.equal(store.getSnapshot(), 'light')
  assert.equal(root.dataset.theme, 'light')
  assert.equal(root.style.colorScheme, 'light')
  assert.equal(meta.content, root.style.backgroundColor)
})

test('selection persists across new page sessions; failed writes still update the current app', () => {
  const a = browser()
  a.store.set('light')
  assert.equal(browser(a.stored.get('atlas.theme.v1')).store.getSnapshot(), 'light')
  a.store.set('invalid'); assert.equal(a.store.getSnapshot(), 'light')
  const blocked = browser(undefined, true)
  blocked.store.set('light'); assert.equal(blocked.root.dataset.theme, 'light')
  blocked.store.set('dark'); assert.equal(blocked.root.style.colorScheme, 'dark')
})

test('subscriptions clean up, repeated initialization is idempotent, and other browser tabs synchronize', () => {
  const a = browser(), observed = []
  const unsubscribe = a.store.subscribe(() => observed.push(a.store.getSnapshot()))
  a.rerun(); a.rerun(); assert.equal(a.events.get('storage').length, 1)
  a.event({ key: 'unrelated', newValue: 'light' }); assert.equal(observed.length, 0)
  a.event({ key: 'atlas.theme.v1', newValue: 'light', storageArea: {} }); assert.equal(observed.length, 0)
  a.event({ key: 'atlas.theme.v1', newValue: 'light' })
  a.event({ key: 'atlas.theme.v1', newValue: 'light' }); assert.equal(observed.length, 1)
  a.event({ key: null, newValue: null }); assert.deepEqual(observed, ['light', 'dark'])
  unsubscribe(); a.store.set('light'); assert.equal(observed.length, 2)
})

test('chart theme updates reuse the instance without invoking data or visible-range APIs', () => {
  const a = browser(), applied = [], seriesUpdates = []
  const chart = { applyOptions: options => applied.push(options), panes: () => [{}, {}], priceScale: () => ({ applyOptions() {} }),
    setData: () => assert.fail('Theme must not set chart data'), remove: () => assert.fail('Theme must not remove chart'),
    timeScale: () => assert.fail('Theme must not alter time range') }
  const detach = bindChartTheme(chart, palette => seriesUpdates.push(palette), { get: a.store.getSnapshot, subscribe: a.store.subscribe })
  const initial = applied[0].layout.background.color
  for (let i = 0; i < 20; i++) a.store.set(i % 2 === 0 ? 'light' : 'dark')
  assert.equal(applied.length, 21); assert.equal(seriesUpdates.length, 21)
  assert.notEqual(applied[1].layout.background.color, initial)
  detach(); a.store.set('light'); assert.equal(applied.length, 21)
})
