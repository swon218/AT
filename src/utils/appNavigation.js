const pages = new Set(['dashboard', 'order', 'lab', 'screen', 'alerts', 'agent', 'assets', 'news', 'company', 'admin'])
const mode = value => value === 'trading' ? 'trading' : 'analysis'

export function readAppRoute(href, previousMode = 'analysis') {
  const url = new URL(href, 'http://atlas.local')
  // Existing Kakao messages and saved links use this legacy entry point.
  const page = url.searchParams.get('agent') === 'alerts' ? 'alerts'
    : pages.has(url.searchParams.get('page')) ? url.searchParams.get('page') : 'dashboard'
  return { page, agentMode: page === 'agent' ? mode(url.searchParams.get('agent')) : mode(previousMode), hash: url.hash }
}

export function appRouteUrl(href, route) {
  const url = new URL(href, 'http://atlas.local')
  url.searchParams.set('page', pages.has(route.page) ? route.page : 'dashboard')
  if (route.page === 'agent' && route.agentMode === 'trading') url.searchParams.set('agent', 'trading')
  else url.searchParams.delete('agent')
  url.hash = route.hash || ''
  return `${url.pathname}${url.search}${url.hash}`
}

export function nextAppRoute(current, page, agentMode = current.agentMode) {
  return { page: pages.has(page) ? page : 'dashboard', agentMode: mode(agentMode), hash: '' }
}
