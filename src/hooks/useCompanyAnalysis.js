import { useEffect, useState } from 'react'

const apiBase = import.meta.env.VITE_API_BASE_URL ?? ''
const attempts = 20
const messages = {
  dart_key_missing: '기업정보 서버의 인증 설정을 확인하는 중입니다.',
  dart_key_invalid: '기업정보 제공처 인증에 실패했습니다.',
  dart_ip_restricted: '기업정보 제공처에서 서버의 접근을 제한했습니다.',
  dart_rate_limit: '기업정보 조회 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.',
  dart_request_limit: '짧은 시간에 너무 많이 조회했습니다. 잠시 후 다시 시도해 주세요.',
  dart_schema_missing: '기업정보 저장소가 아직 준비되지 않았습니다.',
  dart_catalog_not_ready: '기업과 종목을 연결하는 정보를 준비하고 있습니다.',
  dart_database_permission: '기업정보 저장소의 접근 설정을 확인하는 중입니다.',
  dart_invalid_query: '조회 기간이나 페이지를 확인해 주세요.',
  dart_report_version: '공시와 수신한 보고서의 버전이 달라 확인 중입니다.',
  dart_endpoint_missing: '기업정보 조회 서비스가 아직 배포되지 않았습니다.',
}

export function companyErrorMessage(code) {
  return messages[code] || '기업정보를 일시적으로 불러오지 못했습니다.'
}

export default function useCompanyAnalysis(symbol, params) {
  const url = symbol && params ? `${apiBase}/api/public/company/${encodeURIComponent(symbol)}?${new URLSearchParams(params)}` : null
  const [state, setState] = useState(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!url) return
    const controller = new AbortController()
    let timer
    let count = 0
    async function load() {
      try {
        const response = await fetch(url, { signal: controller.signal })
        const body = await response.json().catch(() => null)
        if (controller.signal.aborted) return
        if (!body?.status || typeof body.status !== 'string') {
          setState({ url, result: { status: 'error', error: response.status === 404 ? 'dart_endpoint_missing' : 'dart_unavailable' } })
          return
        }
        const refresh = body.status === 'loading' || body.refreshing
        const canPoll = refresh && ++count < attempts
        setState({ url, result: { ...body, waiting: refresh && !canPoll } })
        if (canPoll) timer = setTimeout(load, 3000)
      } catch {
        if (!controller.signal.aborted) setState({ url, result: { status: 'error', error: 'dart_unavailable' } })
      }
    }
    void load()
    return () => { clearTimeout(timer); controller.abort() }
  }, [url, revision])

  if (!url) return { status: 'disconnected' }
  const current = state?.url === url ? state.result : { status: 'loading' }
  return { ...current, retry: () => setRevision(value => value + 1) }
}
