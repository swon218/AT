import { useEffect, useRef, useState } from 'react'
import { screenerApi } from '../services/screenerApi'
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
    const controller = new AbortController(); control.current = controller
    setBusy(true); setError('')
    // Each call has its own bounded server budget. Resume only the same DB
    // snapshot and condition set; partial results never become a complete scan.
    try {
      let current = next, previous = -1
      for (let attempt = 0; attempt < 4; attempt++) {
        const data = await screenerApi(current, controller.signal)
        if (control.current !== controller) return
        setResult(data)
        if (!data.coverage.not_scanned || data.coverage.scanned <= previous) break
        previous = data.coverage.scanned
        current = { ...current, snapshot_id: data.snapshot_id }
      }
    } catch (e) { if (control.current === controller && e.name !== 'AbortError') setError(e.message) }
    finally { if (control.current === controller) { control.current = null; setBusy(false) } }
  }
  return { query, edit, open, result, meta, error, busy, search, stop, loadMeta,formVersion }
}
