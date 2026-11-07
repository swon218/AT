// Installed by the blocking head script in each HTML entry, before React starts.
const serverSnapshot = () => 'dark'
export const getTheme = () => typeof window === 'undefined' ? 'dark' : window.atlasTheme?.getSnapshot() || 'dark'
export const setTheme = value => window.atlasTheme?.set(value)
export const subscribeTheme = listener => typeof window === 'undefined' ? () => {} : window.atlasTheme?.subscribe(listener) || (() => {})
export { serverSnapshot }
