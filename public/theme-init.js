// Blocking head script: apply the browser preference before CSS and React paint.
// The guard keeps one store/listener if a preview initializes it again.
;(function () {
  if (typeof window === 'undefined' || window.atlasTheme) return
  var key = 'atlas.theme.v1'
  var valid = function (value) { return value === 'light' || value === 'dark' }
  var listeners = new Set()
  var current = 'dark'
  try { var saved = window.localStorage.getItem(key); if (valid(saved)) current = saved } catch (_) {}
  function apply() {
    var root = document.documentElement
    root.dataset.theme = current
    root.style.colorScheme = current
    root.style.backgroundColor = current === 'light' ? '#f4f7fb' : '#07101d'
    var meta = document.querySelector('meta[name="theme-color"]')
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta) }
    meta.content = current === 'light' ? '#f4f7fb' : '#08111f'
  }
  function change(value, persist) {
    if (!valid(value)) return
    if (persist) { try { window.localStorage.setItem(key, value) } catch (_) {} }
    if (value === current) return
    current = value
    apply()
    listeners.forEach(function (listener) { listener() })
  }
  apply()
  window.atlasTheme = {
    getSnapshot: function () { return current },
    set: function (value) { change(value, true) },
    subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener) } },
  }
  window.addEventListener('storage', function (event) {
    if (event.storageArea) {
      try { if (event.storageArea !== window.localStorage) return } catch (_) { return }
    }
    if (event.key === key || event.key === null) change(valid(event.newValue) ? event.newValue : 'dark', false)
  })
})()
