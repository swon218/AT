import { useEffect, useRef, useState } from 'react'
import { screenerApi,readScreenBatch,screenServerReady } from '../services/screenerApi'
import { defaultQuery, importQuery, queryProblem } from '../utils/screener'

export default function useScreener(owner) {
  const [query, setQuery] = useState(defaultQuery)
  const [result, setResult] = useState(null)
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [formVersion,setFormVersion]=useState(0)
  const control = useRef(null)
  const stop = () => { control.current?.abort(); control.current = null; setBusy(false) }
  useEffect(() => {
    stop(); setQuery(defaultQuery()); setResult(null); setError('');setFormVersion(v=>v+1)
    return () => control.current?.abort()
  }, [owner])
  const loadMeta = async () => {
    try { setMeta(await screenerApi()) } catch { setMeta({ unavailable: true }) }
  }
  const edit = (next,{resetEditors=false}={}) => { stop(); setQuery({ ...next, page: 1, snapshot_id: null }); setResult(null); setError('');if(resetEditors)setFormVersion(v=>v+1) }
  const open = input => { const next = importQuery(input); if (next) edit(next,{resetEditors:true}); return !!next }
  const search = async (next = { ...query, page: 1, snapshot_id: null }) => {
    stop()
    const problem=queryProblem(next)
    if(problem){setError(problem);return}
    if(!screenServerReady(meta)){setError('조건 검색 서버 업데이트 또는 연결 상태를 확인해 주세요. 데이터 상태를 새로고침한 뒤 다시 시도해 주세요.');return}
    const controller = new AbortController(); control.current = controller
    setBusy(true); setError('')
    // Each call has its own bounded server budget. Resume only the same DB
    // snapshot and condition set; partial results never become a complete scan.
    try {
      await readScreenBatch(next,{signal:controller.signal,
        previous:next.snapshot_id&&result?.snapshot_id===next.snapshot_id?result:null,
        isCurrent:()=>control.current===controller,onResult:setResult})
    } catch (e) { if (control.current === controller && e.name !== 'AbortError') setError(e.message) }
    finally { if (control.current === controller) { control.current = null; setBusy(false) } }
  }
  return { query, edit, open, result, meta, error, busy, search, stop, loadMeta,formVersion,serverReady:screenServerReady(meta) }
}
