import { inflateRawSync } from 'node:zlib'

export class DartError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

const endpointNames = new Set([
  'corpCode.xml', 'document.xml', 'company.json', 'list.json', 'fnlttSinglAcntAll.json',
  'hyslrSttus.json', 'alotMatter.json', 'accnutAdtorNmNdAdtOpinion.json',
  'majorstock.json',
])
const statuses = {
  '010': 'dart_key_invalid', '011': 'dart_key_invalid', '901': 'dart_key_invalid',
  '012': 'dart_ip_restricted', '020': 'dart_rate_limit', '800': 'dart_unavailable',
}
const MB = 1024 * 1024

async function readBounded(response, maxBytes) {
  const reader = response.body?.getReader()
  if (!reader) throw new DartError('dart_invalid_response')
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maxBytes) throw new DartError('dart_response_too_large')
      chunks.push(value)
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks, size)
}

export function createDartClient({ key, reserve, transport = fetch }) {
  return async function request(endpoint, params, signal) {
    if (!endpointNames.has(endpoint)) throw new DartError('dart_invalid_request')
    if (!key) throw new DartError('dart_key_missing')
    signal?.throwIfAborted()
    if (!await reserve()) throw new DartError('dart_rate_limit')
    const zip = endpoint.endsWith('.xml')
    const url = new URL(`https://opendart.fss.or.kr/api/${endpoint}`)
    url.search = new URLSearchParams({ ...params, crtfc_key: key })
    try {
      const timeout = AbortSignal.timeout(12_000)
      const response = await transport(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
      if (response.status === 429) throw new DartError('dart_rate_limit')
      if (!response.ok) throw new DartError('dart_unavailable')
      const bytes = await readBounded(response, zip ? 24 * MB : 8 * MB)
      if (zip && bytes.length > 4 && bytes.readUInt32LE(0) === 0x04034b50) return bytes
      const body = bytes.toString('utf8')
      const payload = body.trimStart().startsWith('{') ? JSON.parse(body) : { status: body.match(/<status>(\d{3})<\/status>/)?.[1] }
      if (payload.status === '013' || (zip && payload.status === '014')) return null
      if (payload.status !== '000') throw new DartError(statuses[payload.status] || 'dart_invalid_response')
      if (zip) throw new DartError('dart_invalid_response')
      return payload
    } catch (error) {
      // Transport errors can contain the full URL and credential.
      if (error instanceof DartError) throw error
      throw new DartError(error.name === 'TimeoutError' || signal?.aborted ? 'dart_timeout' : 'dart_unavailable')
    }
  }
}

// Read one selected XML member in memory. Never write an archive path to disk.
export function dartXmlFromZip(bytes, selectFile, maxOutput = 32 * MB) {
  try {
    let end = bytes.length - 22
    const first = Math.max(0, end - 65535)
    while (end >= first && !(bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length)) end--
    if (end < first || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error()
    const count = bytes.readUInt16LE(end + 10)
    let pos = bytes.readUInt32LE(end + 16)
    if (!count || count > 256 || pos >= end) throw new Error()
    const candidates = []
    for (let i = 0; i < count; i++) {
      if (pos + 46 > end || bytes.readUInt32LE(pos) !== 0x02014b50) throw new Error()
      const length = bytes.readUInt16LE(pos + 28)
      const next = pos + 46 + length + bytes.readUInt16LE(pos + 30) + bytes.readUInt16LE(pos + 32)
      if (next > end) throw new Error()
      const name = bytes.toString('utf8', pos + 46, pos + 46 + length)
      if (selectFile(name)) candidates.push(pos)
      pos = next
    }
    if (candidates.length !== 1) throw new Error()
    const entry = candidates[0]
    const method = bytes.readUInt16LE(entry + 10)
    const compressed = bytes.readUInt32LE(entry + 20)
    const size = bytes.readUInt32LE(entry + 24)
    const local = bytes.readUInt32LE(entry + 42)
    if (bytes.readUInt16LE(entry + 8) & 1 || !size || size > maxOutput || local + 30 > end || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error()
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    if (start + compressed > end || ![0, 8].includes(method)) throw new Error()
    const input = bytes.subarray(start, start + compressed)
    const result = method === 0 ? input : inflateRawSync(input, { maxOutputLength: maxOutput })
    if (result.length !== size) throw new Error()
    const utf8 = result.toString('utf8')
    const xml = utf8.includes('\uFFFD') ? new TextDecoder('euc-kr', { fatal: true }).decode(result) : utf8
    // DART documents may declare an external DTD. This tokenizer never resolves it.
    if (/<!ENTITY\b|<!DOCTYPE[^>]*\[/i.test(xml)) throw new Error()
    return xml
  } catch {
    throw new DartError('dart_invalid_archive')
  }
}

export const xmlText = value => value.replace(/<[^>]*>/g, ' ').replace(/&(amp|lt|gt|quot|apos|nbsp|#160);/g,
  (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#160': ' ' })[entity])
  .replace(/\s+/g, ' ').trim()

export function readDartSymbols(bytes) {
  const xml = dartXmlFromZip(bytes, name => /^CORPCODE\.xml$/i.test(name))
  const symbols = new Map()
  const conflicts = new Set()
  for (const [, row] of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
    const field = tag => xmlText(row.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? '')
    const symbol = field('stock_code')
    const corp_code = field('corp_code')
    const name = field('corp_name')
    const day = field('modify_date')
    if (!/^[0-9][0-9A-Z]{5}$/.test(symbol) || !/^\d{8}$/.test(corp_code) || !/^\d{8}$/.test(day) || !name) continue
    if (symbols.has(symbol) && symbols.get(symbol).corp_code !== corp_code) conflicts.add(symbol)
    symbols.set(symbol, { symbol, corp_code, name, modified_on: day.replace(/^(....)(..)(..)$/, '$1-$2-$3') })
  }
  for (const conflict of conflicts) symbols.delete(conflict)
  if (!symbols.size) throw new DartError('dart_invalid_archive')
  return [...symbols.values()]
}
