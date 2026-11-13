export function describeChartScope(record,period){
  if(record?.error)return `${period.endsWith('분')?'한국 시간':'날짜 기준'} · 차트 조회 실패`
  const m=record?.meta
  if(!m)return `${period.endsWith('분')?'한국 시간':'날짜 기준'} · ${record?`최근 ${record.returnedCount}개 봉 · 제공 범위 정보 없음`:'조회 범위 확인 중'}`
  const count=m.returnedCount??record.returnedCount??0
  const text=[period.endsWith('분')?'한국 시간':'날짜 기준',`최근 ${count}개 봉 (최대 ${m.requestedLimit??200}개 요청)`]
  text.push(({KRX:'KRX',NXT:'NXT',INTEGRATED:'통합 거래소'})[m.market]||'API 제공 거래소')
  if(period.endsWith('분')){
    text.push(m.sessionCoverage==='all-requested'?'시간외 포함 요청':m.sessionCoverage==='regular-requested'?'정규장 요청':'시간외 포함 범위 미확인')
    text.push(m.timestampMeaning==='start'?'봉 시작 시각':m.timestampMeaning==='end'?'봉 종료 시각':'증권사 기준 시각')
    if(m.aggregated||m.aggregation==='resampled')text.push(`${period} 합성`)
  }
  if(m.partial)text.push('부분 조회')
  return text.join(' · ')
}
