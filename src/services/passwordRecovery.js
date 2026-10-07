export const RECOVERY_LINK_ERROR = '재설정 링크가 만료되었거나 유효하지 않습니다. 비밀번호 찾기에서 새 링크를 요청해 주세요.'

// Read before Supabase consumes and removes the callback fragment.
export function readRecoveryRequest(href) {
  const url = new URL(href)
  const hash = new URLSearchParams(url.hash.slice(1))
  return {
    requested: url.searchParams.get('auth') === 'reset-password' || hash.get('type') === 'recovery',
    failed: Boolean(hash.get('error') || hash.get('error_code') || url.searchParams.get('error') || url.searchParams.get('error_code')),
  }
}

export function passwordResetRedirect(href) {
  const url = new URL(href)
  url.search = '?auth=reset-password'
  url.hash = ''
  return url.href
}

export function clearRecoveryUrl(href) {
  const url = new URL(href)
  url.searchParams.delete('auth')
  for (const key of ['code', 'error', 'error_code', 'error_description']) url.searchParams.delete(key)
  const hash = new URLSearchParams(url.hash.slice(1))
  if (hash.has('access_token') || hash.has('error') || hash.has('error_code') || hash.get('type') === 'recovery') url.hash = ''
  return `${url.pathname}${url.search}${url.hash}`
}

export async function initializePasswordRecovery(auth, request) {
  const { error: initializationError } = await auth.initialize()
  const { data, error: sessionError } = await auth.getSession()
  const session = data?.session ?? null
  return {
    session,
    recovery: request.requested ? {
      status: !request.failed && !initializationError && !sessionError && session ? 'ready' : 'error',
      message: RECOVERY_LINK_ERROR,
    } : null,
  }
}
