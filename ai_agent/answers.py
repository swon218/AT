"""Validate and render server-grounded ATLAS answers."""
from decimal import Decimal
import json
import re
from .screen_engine import REASONS

AMOUNT = re.compile(r'(?<![\d.,])(?P<number>(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(?:(?P<scale>억|천만|백만|십만|만|천|백|십)\s*원|(?P<unit>원|%))')
WON_SCALE = {'억': 10**8, '천만': 10**7, '백만': 10**6, '십만': 10**5, '만': 10**4, '천': 10**3, '백': 100, '십': 10}
OTHER_NUMERIC_FACT = re.compile(r'RSI\s*[:=]?\s*\d|\d[,.\d]*\s*종목', re.I)
ALERT_CONDITION_AFTER = re.compile(r'\s*(?:(?:에|이|가|를|으로|일)\s*)?(?:(?:에\s*)?도달\s*(?:하면|할\s*때|하는\s*경우|시|조건)|(?:상승|하락)\s*(?:하면|할\s*때|하는\s*경우|시|조건)|알림|조건|때\s*알림)')
ALERT_CONDITION_BEFORE = re.compile(r'(?:목표가|목표\s*가격|조건값|알림\s*(?:가격|목표가)|(?:요청|지정)하신\s*(?:가격|금액))\s*(?:는|은|가|이|를|:|=)?\s*$')
QUOTE_LABEL = r'(?:현재가|현재\s*가격|실시간\s*시세|지금\s*가격|시세|주가|종가|등락률)\s*'
QUOTE_BEFORE = re.compile(QUOTE_LABEL + r'(?:가|이|는|은|:|=)\s*$')
QUOTE_LABEL_BEFORE = re.compile(QUOTE_LABEL + r'(?:가|이|는|은|:|=)?\s*$')
QUOTE_AFTER = re.compile(r'\s*(?:에서|에)?\s*(?:거래\s*(?:중|되)|마감|기록)')
HYPOTHETICAL_AFTER = re.compile(r'\s*(?:에\s*)?(?:(?:도달|상승|하락)\s*(?:하면|할\s*때|하는\s*경우|시)|일\s*때\s*알림)')
WATCHLIST_APPROVAL = re.compile(
    r'관심\s*종목[\s\S]{0,120}?(?:(?:추가|등록)\s*(?:할까요|하시겠(?:어요|습니까)|해\s*드릴까요|해도\s*될까요|를?\s*원하시나요|할지\s*알려)|'
    r'넣(?:을까요|으시겠(?:어요|습니까)))'
)
VALIDATION_HINTS = {
    'unsupported_claims': 'For clarification or insufficient, return claims=[] and sentiment=자료 부족.',
    'unsupported_current_facts': 'Remove unsupported facts. Restate a user-supplied target only as an explicit alert condition in a clarification.',
    'alert_proposal_required': 'Do not ask for watchlist consent in prose. Use propose_alert for the requested alert or ask only for a missing detail.',
}
VALIDATION_CODES = set(VALIDATION_HINTS) | {
    'unsafe_investment_instruction', 'fresh_evidence_required', 'evidence_required', 'invalid_evidence_id',
    'excerpt_mismatch', 'rsi_value_mismatch', 'unverified_company_relevance', 'unsupported_number',
    'claim_content_mismatch', 'uncited_summary_numbers',
    'unavailable_source_claim',
}


def current_required(question):
    if re.search(r'저장된|내\s*(?:알림|관심종목|카카오)|발송\s*(?:상태|이력)|연결\s*(?:됐|되어)', question):
        return True
    if re.search(r'그중|그 중|앞서|이전|아까|방금', question) and not re.search(r'오늘|현재|최신|최근|밤사이', question):
        return False
    return bool(re.search(r'뉴스|밤사이|오늘|현재|지금|시세|분봉|틱|최근|찾아|검색해|종목들|이하|이상', question, re.I))


def condition_amount(match):
    number = Decimal(match['number'].replace(',', ''))
    unit = match['unit'] or '원'
    scale = WON_SCALE.get(match['scale'], 1)
    maximum = 100 if unit == '%' else 1_000_000_000
    if number > maximum / scale:
        return None
    return unit, number * scale


def clarification_has_unverified_facts(summary, question, draft):
    if OTHER_NUMERIC_FACT.search(summary) or re.search(r'긍정 우세|부정 우세', summary):
        return True
    supplied = {condition_amount(match) for match in AMOUNT.finditer(question)}
    supplied.discard(None)
    if draft and draft.get('kind') in ('price_touch', 'rise_gte', 'fall_lte') and draft.get('threshold'):
        unit = '원' if draft['kind'] == 'price_touch' else '%'
        supplied.add((unit, Decimal(str(draft['threshold']))))
    # A quoted condition must be part of a question and tied to a conditional/alert expression.
    # Merely repeating the same number in a current-price assertion is still unsupported.
    for clause in re.split(r'(?<=[.!?])\s+|\n+', summary):
        for match in AMOUNT.finditer(clause):
            before, after = clause[:match.start()], clause[match.end():]
            if (not clause.rstrip().endswith('?') or condition_amount(match) not in supplied
                    or not (ALERT_CONDITION_AFTER.match(after) or ALERT_CONDITION_BEFORE.search(before))
                    or QUOTE_AFTER.match(after)
                    or (QUOTE_BEFORE.search(before) and not HYPOTHETICAL_AFTER.match(after))):
                return True
    return False


def validate_final(final, tools, question, *, alert_editor_read=False):
    verified_intraday = any(claim.evidence_id.startswith('m_') and claim.evidence_id in tools.fresh_ids for claim in final.claims)
    unsupported = r'DART|다트|실시간' if verified_intraday else r'DART|다트|실시간|장중'
    if re.search(r'(?:' + unsupported + r')[^\n.!?]{0,30}(?:확인했|조회했|수신했|제공받|분석했)', final.model_dump_json(), re.I):
        raise ValueError('unavailable_source_claim')
    if re.search(r'(?:지금|반드시|즉시).{0,8}(?:매수|매도)|(?:매수|매도).{0,4}(?:추천|하세요)|사세요|파세요|수익.{0,5}보장|확실히.{0,8}(?:상승|하락)', final.model_dump_json()):
        raise ValueError('unsafe_investment_instruction')
    if final.kind in ('clarification', 'insufficient'):
        if final.claims or final.sentiment != '자료 부족':
            raise ValueError('unsupported_claims')
        draft = tools.alerts.draft if alert_editor_read else None
        unsupported_summary = clarification_has_unverified_facts(final.summary, question, draft) if final.kind == 'clarification' else (
            AMOUNT.search(final.summary) or OTHER_NUMERIC_FACT.search(final.summary) or re.search(r'긍정 우세|부정 우세', final.summary)
        )
        if unsupported_summary or any(AMOUNT.search(line) or OTHER_NUMERIC_FACT.search(line) for line in final.uncertainty):
            raise ValueError('unsupported_current_facts')
        return
    if final.kind == 'concept':
        if final.claims:
            raise ValueError('unsupported_claims')
        if current_required(question):
            raise ValueError('fresh_evidence_required')
        for line in [final.summary, *final.uncertainty]:
            for match in AMOUNT.finditer(line):
                before, after = line[:match.start()], line[match.end():]
                if QUOTE_AFTER.match(after) or (QUOTE_LABEL_BEFORE.search(before) and not HYPOTHETICAL_AFTER.match(after)):
                    raise ValueError('unsupported_current_facts')
    if final.kind == 'research':
        if not final.claims:
            raise ValueError('evidence_required')
        if current_required(question) and not any(c.evidence_id in tools.fresh_ids for c in final.claims):
            raise ValueError('fresh_evidence_required')
        for claim in final.claims:
            source = tools.evidence.get(claim.evidence_id)
            if not source:
                raise ValueError('invalid_evidence_id')
            text = source.get('excerpt') or (source.get('title', '') + ' ' + source.get('snippet', ''))
            if claim.excerpt not in text:
                raise ValueError('excerpt_mismatch')
            if claim.evidence_id.startswith(('r_', 'f_', 'i_', 'q_', 'm_')) and claim.excerpt != source['excerpt']:
                raise ValueError('rsi_value_mismatch')
            if claim.relation == 'direct' and source.get('relevance') == 'indirect_or_unrelated_review_required':
                raise ValueError('unverified_company_relevance')
            # Numeric assertions must be present in the cited evidence; Korean linguistic entailment is evaluated separately.
            for number in re.findall(r'\d+(?:\.\d+)?', claim.text):
                if number not in text:
                    raise ValueError('unsupported_number')
            if claim.evidence_id.startswith('n_'):
                # Detect direct factual reversals in addition to ID/excerpt checks. This is a bounded
                # lexical check, not a claim of complete semantic entailment or real model quality.
                for left, right in [('증가', '감소'), ('흑자', '적자'), ('상향', '하향'), ('개선', '악화')]:
                    if ((left in claim.text and right in text and left not in text) or
                        (right in claim.text and left in text and right not in text)):
                        raise ValueError('claim_content_mismatch')
                terms = set(re.findall(r'[가-힣A-Za-z]{2,}', claim.text))
                evidence_terms = set(re.findall(r'[가-힣A-Za-z]{2,}', text))
                if terms and not any(any(a in b or b in a for b in evidence_terms) for a in terms):
                    raise ValueError('claim_content_mismatch')
        if AMOUNT.search(final.summary) or OTHER_NUMERIC_FACT.search(final.summary):
            raise ValueError('uncited_summary_numbers')


def materialize(final, tools, now, prompt_version='atlas-langgraph-v1'):
    ids = list(dict.fromkeys(c.evidence_id for c in final.claims))
    sources = [tools.evidence[i] for i in ids]
    coverage = tools.coverage
    # Always disclose actual research coverage, regardless of what the model says.
    lines = [final.summary]
    if any(c['kind'] == 'news' for c in coverage):
        lines.append(f'뉴스 흐름: {final.sentiment}')
    for claim in final.claims:
        stance = {'positive': '긍정 요인', 'negative': '부정 요인', 'neutral': '중립'}[claim.stance]
        relation = {'direct': '기업 직접', 'indirect': '간접 영향'}[claim.relation]
        lines.append(f"• [{stance} / {relation}] {claim.text}\n  근거: {claim.excerpt} [{claim.evidence_id}]")
    lines.append('확인 한계: ' + ' / '.join(final.uncertainty))
    for c in coverage:
        if c['kind'] in ('rsi', 'screen'):
            title = 'RSI' if c['kind'] == 'rsi' else '조건검색'
            exclusions = ', '.join(f"{REASONS.get(reason, reason)} {count}개" for reason, count in c['excluded'].items())
            detail = f' ({exclusions})' if exclusions else ''
            lines.append(f"{title} 범위: 수집 대상 {c['universe']}개, 유효 {c['valid']}개, 제외 {sum(c['excluded'].values())}개{detail}, 미검색 {c['not_scanned']}개. 조건 일치 {c['matches']}개 중 {c['returned']}개 반환, {c['page']}페이지. 기준 {c['as_of']}, {c['sort']}.")
        elif c['kind'] in ('quote','intraday'):
            label = '최신 조회 시세' if c['kind'] == 'quote' else '장중 차트'
            lines.append(f"{label}: {c['name']}({c['code']}), 시장 {c['market']}, 공급자 기준 {c.get('provider_at') or '확인 불가'}, 조회 {c.get('queried_at') or '확인 불가'}, 캐시 {c.get('cache_hit')}, 현재 정규장 상태 {c.get('current_session')}, 오래된 데이터 {c.get('data_stale')}. 실시간·지연 여부 확인 불가.")
            lines.extend(c.get('warnings') or [])
        elif c['kind'] == 'indicator':
            reasons = [REASONS.get(reason, reason) for reason in c['excluded']]
            reasons.extend(f"{item['label']} — {item['reason']}" for item in c['unavailable'])
            lines.append(f"지표 조회: {c['name']}({c['code']}), 실험실 확정 일봉 기준 {c['as_of']}." + (f" 확인 불가: {', '.join(reasons)}." if reasons else ''))
        else:
            lines.append(f"뉴스 조회: {c['name']}({c['code']}), {c['period']['start']} ~ {c['period']['end']}, {c['page']}페이지 {c['fetched']}건 수신/{c['accepted']}건 기간 내 확보. 제목·요약 범위.")
    screens = [c for c in coverage if c['kind'] in ('rsi', 'screen')]
    news_codes = {c['code'] for c in coverage if c['kind'] == 'news'}
    if screens and news_codes:
        lines.append(f"뉴스 조사 종목 {len(news_codes)}개. 검색 조건 일치 {screens[-1]['matches']}개 중 뉴스 미조사 {max(0, screens[-1]['matches'] - len(news_codes))}개. 전체 국내 종목 조사 결과가 아닙니다.")
    lines.append('분석 기준: ' + now.isoformat() + ' (Asia/Seoul). 투자 판단의 참고 자료입니다.')
    result = {'content': '\n\n'.join(lines), 'kind': final.kind, 'sentiment': final.sentiment,
            'claims': [c.model_dump() for c in final.claims], 'sources': sources,
            'coverage': coverage, 'result_sets': tools.result_sets[-3:], 'as_of': now.isoformat(), 'prompt_version': prompt_version}
    # Supabase and Node both cap each saved answer at 100 kB. Multiple wide
    # screen pages may exceed it. Keep evidence and query/coverage authoritative;
    # bound only saved result rows and disclose that truncation.
    trimmed = False
    while len(json.dumps(result, ensure_ascii=False).encode()) > 90000 and result['result_sets']:
        result['result_sets'] = [dict(s) for s in result['result_sets']]
        if len(result['result_sets']) > 1:
            result['result_sets'].pop(0)
        elif result['result_sets'][0].get('items'):
            result['result_sets'][0]['items'] = result['result_sets'][0]['items'][:-1]
            result['result_sets'][0]['stored_items_truncated'] = True
        else:
            break
        trimmed = True
    if trimmed:
        result['content'] += '\n\n저장된 결과 목록 일부는 크기 제한으로 생략했습니다. 조건검색에서 같은 조건을 다시 조회할 수 있습니다.'
    return result
