"""Deterministic interpretation of bounded, normalized market reads."""
from datetime import datetime
import math
from .data_source import DataError, read_data
from .market import alert_session, market_context


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def session_context(tools, provider_at):
    try:
        session = alert_session(tools.now, tools.settings.calendar_through)
        if session.get('closed'):
            current = 'holiday'
        elif tools.now < datetime.fromisoformat(session['open']):
            current = 'before_regular'
        elif tools.now < datetime.fromisoformat(session['close']):
            current = 'regular'
        else:
            current = 'after_regular'
        context = market_context(tools.now, tools.settings.calendar_through)
        stale = bool(provider_at and provider_at[:10] < (session['date'] if current == 'regular' else context['latest_completed']))
        return {'current_session': current, 'session_source': context['calendar_source'],
                'data_stale': stale if provider_at else None}
    except ValueError:
        return {'current_session': 'unknown', 'session_source': None, 'data_stale': None}


async def market_symbol(tools, args):
    value = await read_data(tools, 'resolve_market_symbol', args, 2)
    if value['status'] == 'error':
        return value
    rows = value.get('items')
    if not isinstance(rows, list) or len(rows) > 10 or any(not isinstance(row,dict) or not row.get('code') or not row.get('name') for row in rows):
        raise DataError('invalid_data_response')
    if len(rows) == 1:
        tools.resolved[rows[0]['code']] = rows[0]
    return {**value, 'ambiguous': len(rows) > 1}


async def market_quote(tools, args, identify):
    value = await read_data(tools, 'get_market_quote', args)
    if value['status'] == 'error':
        return value
    if value.get('code') != args.code or not value.get('name') or not finite(value.get('price')) or value['price'] <= 0:
        raise DataError('invalid_data_response')
    for key in ('change','changeAmount','volume'):
        if value.get(key) is not None and not finite(value[key]):
            raise DataError('invalid_data_response')
    metadata = {key:value.get(key) for key in ('market','currency','volume_unit','provider_at','queried_at','served_at','cache_hit','cache_age_ms','realtime','delay','adjusted','observation','source','warnings')}
    metadata.update(session_context(tools, value.get('provider_at')))
    price = value['price']
    delta = '확인 불가' if value.get('changeAmount') is None else f"{value['changeAmount']:+g}원"
    rate = '확인 불가' if value.get('change') is None else f"{value['change']:+g}%"
    volume = '확인 불가' if value.get('volume') is None else f"{value['volume']:g}주"
    excerpt = f"{value['name']}({args.code}) KRX 최신 조회가 {price:g}원, 전일 대비 {delta} / {rate}, 누적 거래량 {volume}. 공급자 시각 미제공, 실시간·지연 여부 확인 불가."
    source = {'id':identify('q_', [args.model_dump(),value]), 'code':args.code,'name':value['name'],
              'excerpt':excerpt,'as_of':value.get('provider_at'), **metadata, 'scope':'quote'}
    tools.remember(source)
    tools.resolved[args.code] = {'code':args.code,'name':value['name'],'market':'KRX'}
    coverage = {'kind':'quote','code':args.code,'name':value['name'],'as_of':source['as_of'], **metadata}
    tools.coverage.append(coverage)
    return {'status':value['status'],'items':[source],'coverage':coverage,'source':source['source'],'as_of':source['as_of'],
            'values':{key:value.get(key) for key in ('price','change','changeAmount','volume')},'queried_at':value.get('queried_at'),'warnings':value.get('warnings',[])}


async def intraday(tools, args, identify):
    value = await read_data(tools, 'get_intraday_bars', args, 2)
    if value['status'] == 'error':
        return value
    bars = value.get('items')
    if not isinstance(bars,list) or len(bars) > 120:
        raise DataError('invalid_data_response')
    if not bars:
        return {**value,'items':[]}
    for row in bars:
        if not all(finite(row.get(key)) for key in ('open','high','low','close','volume')) or not isinstance(row.get('time'),str):
            raise DataError('invalid_data_response')
    summary = {'open':bars[0]['open'],'close':bars[-1]['close'],'high':max(row['high'] for row in bars),
               'low':min(row['low'] for row in bars),'volume':sum(row['volume'] for row in bars),'bars':len(bars)}
    unit = '분' if args.kind == 'minute' else '틱'
    excerpt = (f"{args.code} KRX {args.interval}{unit} {len(bars)}봉, {bars[0]['time']} ~ {bars[-1]['time']}, "
               f"시가 {summary['open']:g}원·마지막 종가 {summary['close']:g}원·고가 {summary['high']:g}원·저가 {summary['low']:g}원·거래량 합계 {summary['volume']:g}주. 수정주가, 봉 확정 여부 확인 불가.")
    metadata = {key:value.get(key) for key in ('market','currency','volume_unit','provider_at','queried_at','cache_hit','cache_age_ms','realtime','delay','adjusted','source','warnings','requested_period','returned_period','more_available','invalid_rows','truncated')}
    metadata.update(session_context(tools,value.get('provider_at')))
    source = {'id':identify('m_', [args.model_dump(),value]),'code':args.code,'name':tools.resolved.get(args.code,{}).get('name',args.code),
              'excerpt':excerpt,'as_of':value.get('provider_at'),**metadata,'scope':'intraday'}
    tools.remember(source)
    coverage = {'kind':'intraday','code':args.code,'name':source['name'],'as_of':source['as_of'],**metadata,
                'data_rows':len(bars),'model_rows':min(len(bars),24),'summary':summary,'incomplete':value['status']=='partial'}
    tools.coverage.append(coverage)
    return {'status':value['status'],'items':[source],'bars':bars[-24:],'summary':summary,'coverage':coverage,'source':source['source'],
            'as_of':source['as_of'],'queried_at':value.get('queried_at'),'warnings':value.get('warnings',[]) + ['수치 요약은 전체 수신 봉 기준이며 모델에 개별 전달하는 봉은 최근 최대 24개입니다.']}
