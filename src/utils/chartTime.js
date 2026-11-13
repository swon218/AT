// Chart wire contract: intraday UTC seconds; sessionless bars YYYY-MM-DD.
// Formatting never changes the values used by prices, indicators or markers.
export const CHART_TIME_ZONE='Asia/Seoul'
const pad=value=>String(value).padStart(2,'0')
function validDate(y,m,d){
  if(!Number.isInteger(y)||y<1970||y>2199||!Number.isInteger(m)||!Number.isInteger(d))return false
  const date=new Date(Date.UTC(y,m-1,d))
  return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d
}
export function dateOnly(value){
  let y,m,d
  if(value&&typeof value==='object')({year:y,month:m,day:d}=value)
  else{
    const text=String(value??'').trim()
    const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(text)||/^(\d{4})(\d{2})(\d{2})$/.exec(text)
    if(!match)return null
    ;[y,m,d]=match.slice(1).map(Number)
  }
  return validDate(y,m,d)?`${y}-${pad(m)}-${pad(d)}`:null
}
export function utcSeconds(value,{timeZone,unit='auto'}={}){
  if(typeof value==='number'){
    if(!Number.isFinite(value))return null
    const seconds=unit==='milliseconds'||unit==='auto'&&Math.abs(value)>=100000000000?Math.floor(value/1000):Math.floor(value)
    return seconds>=0&&seconds<Date.UTC(2200,0,1)/1000?seconds:null
  }
  const text=String(value??'').trim()
  if(/^\d{10}(?:\d{3})?$/.test(text))return utcSeconds(Number(text),{unit})
  const match=/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(text)
  if(!match)return null
  const [y,m,d,h,minute,second]=match.slice(1,7).map(v=>Number(v||0)),zone=match[8]
  if(!validDate(y,m,d)||h>23||minute>59||second>59)return null
  let offset
  if(zone==='Z'||!zone&&timeZone==='UTC')offset=0
  else if(zone){const zh=Number(zone.slice(1,3)),zm=Number(zone.slice(4));if(zh>14||zm>59||zh===14&&zm!==0)return null;offset=(zh*60+zm)*(zone[0]==='-'?-1:1)}
  else if(timeZone===CHART_TIME_ZONE)offset=540
  else return null
  return Math.floor((Date.UTC(y,m-1,d,h,minute,second,Number((match[7]||'').padEnd(3,'0')))-offset*60000)/1000)
}
export function seoulTimestamp(value,clock){
  let text=String(value??'').trim()
  if(clock!==undefined){const day=dateOnly(value),t=String(clock??'').trim();if(!day||!/^\d{4}(?:\d{2})?$/.test(t))return null;text=day.replaceAll('-','')+t}
  if(/^\d{12}(?:\d{2})?$/.test(text))text=`${text.slice(0,4)}-${text.slice(4,6)}-${text.slice(6,8)}T${text.slice(8,10)}:${text.slice(10,12)}:${text.slice(12)||'00'}`
  return utcSeconds(text,{timeZone:CHART_TIME_ZONE})
}
const seoulParts=new Intl.DateTimeFormat('en-CA',{timeZone:CHART_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
function parts(value){
  const seconds=utcSeconds(value)
  if(seconds===null)return null
  return Object.fromEntries(seoulParts.formatToParts(new Date(seconds*1000)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]))
}
export function koreanDate(value){
  const day=dateOnly(value)
  if(day)return day
  const p=parts(value)
  return p?`${p.year}-${p.month}-${p.day}`:null
}
export function normalizeChartTime(value,{intraday=false,localTimeZone}={}){
  if(intraday)return utcSeconds(value,{timeZone:localTimeZone})
  return dateOnly(value)||koreanDate(value)
}
export function formatChartTime(value,intraday=true){
  const day=dateOnly(value)
  if(day)return `${day.slice(2,4)}년${day.slice(5,7)}월${day.slice(8)}일`
  const p=parts(value)
  if(!p)return '—'
  return `${p.year.slice(-2)}년${p.month}월${p.day}일${intraday?` ${p.hour}:${p.minute}`:''}`
}
export function formatChartTick(value,type,intraday=true){
  const day=dateOnly(value)||koreanDate(value)
  if(!day)return ''
  if(type===0)return `${day.slice(2,4)}년`
  if(type===1)return `${day.slice(5,7)}월`
  if(!intraday||type===2)return `${day.slice(5,7)}/${day.slice(8)}`
  const p=parts(value)
  // A provider-returned midnight is a real day boundary, never a fabricated bar.
  if(p?.hour==='00'&&p.minute==='00')return `${p.month}/${p.day}`
  return p?`${p.hour}:${p.minute}`:''
}
