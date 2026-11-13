import {getCandleResponse} from './charts.js'
import {getTossCandleResponse} from './tossCharts.js'
import {marketRequestContext} from './marketContext.js'
import {httpError} from './brokerHttp.js'
export function chartQuery(query={}){
  const symbol=String(query.symbol||''),interval=String(query.interval||'일')
  if(!/^[0-9][0-9A-Z]{5}$/.test(symbol)||!['1분','5분','10분','15분','30분','60분','일','주','월'].includes(interval))throw httpError('종목과 차트 주기를 확인해 주세요.',400)
  const count=Number(query.limit??200)
  if(!Number.isSafeInteger(count)||count<1||count>500)throw httpError('조회 건수는 1~500개로 지정해 주세요.',400)
  if(query.market!==undefined&&!['KRX','NXT','INTEGRATED'].includes(query.market))throw httpError('차트 거래소를 확인해 주세요.',400)
  if(query.includeExtended!==undefined&&!['true','false'].includes(query.includeExtended))throw httpError('차트 시간외 조회 옵션을 확인해 주세요.',400)
  return {symbol,interval,limit:count,options:{...(query.market?{market:query.market}:{}),...(query.includeExtended!==undefined?{includeExtended:query.includeExtended==='true'}:{})}}
}
export function registerChartRoutes(app,{kiwoom=getCandleResponse,toss=getTossCandleResponse,kiwoomContext=marketRequestContext,tossContext}={}){
  for(const broker of ['kiwoom','toss'])app.get(`/api/public/market/${broker}/candles`,{logLevel:'silent'},async(request,reply)=>{
    reply.header('Cache-Control','private, no-store')
    const controller=new AbortController(),abort=()=>controller.abort()
    request.raw.once('aborted',abort);reply.raw.once('close',abort)
    try{
      const {symbol,interval,limit,options}=chartQuery(request.query)
      if(broker==='toss'&&(options.market||options.includeExtended!==undefined))return reply.code(400).send({code:'chart_option_unsupported',error:'토스 차트 API는 거래소·시간외 선택 인자를 제공하지 않습니다. API가 반환하는 구간을 표시합니다.'})
      if(broker==='kiwoom'&&options.includeExtended!==undefined)return reply.code(400).send({code:'chart_option_unsupported',error:'키움 차트의 시간외 범위는 거래소와 API 제공 구간에 따릅니다. 별도 시간외 선택 인자는 지원하지 않습니다.'})
      const context=await(broker==='kiwoom'?kiwoomContext(request):tossContext(request))
      const data=broker==='kiwoom'?await kiwoom(symbol,interval,limit,{...context,...options,signal:controller.signal}):await toss(symbol,interval,limit,context,{signal:controller.signal})
      return {...data,sourceBroker:broker}
    }catch(error){
      const status=[400,401,403,429,504].includes(error.statusCode)?error.statusCode:502
      return reply.code(status).send({code:status===429?'chart_rate_limited':status===400?'invalid_chart_query':'chart_unavailable',error:status===400?'종목·주기·거래소·조회 건수를 확인해 주세요.':status===401?'로그인 세션을 확인해 주세요.':status===429?'차트 조회 한도에 도달했습니다. 잠시 후 다시 조회해 주세요.':'증권사 차트 응답을 확인하지 못했습니다. 빈 결과나 미지원으로 처리하지 않습니다.'})
    }finally{request.raw.removeListener('aborted',abort);reply.raw.removeListener('close',abort)}
  })
}
