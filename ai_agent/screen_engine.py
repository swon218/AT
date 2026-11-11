"""One read-only daily screen engine for manual UI and AI function calls."""
from collections import OrderedDict
import hashlib
import json
import math
from threading import Lock
from .indicators import VERSION, key, label, condition_label, latest_pair, warmup, compare, metric_unit
from .market import market_context
from .screener import RsiScreener, ScanBusy, ScanChanged
from .screen_models import AdvancedMetric
from .screen_semantics import VERSION as CONDITION_VERSION, metric_spec, percent, ratio_comparison


class ScreenSnapshotChanged(Exception):
    pass


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()[:24]


def metrics_for(query):
    from .screen_models import Metric
    found = {}
    for name in ('close', 'volume'):
        m = Metric(name=name, period=1, slow=1, signal=1, multiplier=1.0)
        found[key(m)] = m
    for condition in query.conditions:
        found[key(condition.left)] = condition.left
        if condition.right.metric: found[key(condition.right.metric)] = condition.right.metric
    return dict(sorted(found.items()))


def bars_from_rows(rows):
    return [{'time': r[1], 'close': r[2], 'open': r[4], 'high': r[5], 'low': r[6], 'volume': r[7]} for r in rows]


REASONS = {'insufficient_warmup': '계산 준비 봉 부족', 'indicator_unavailable': '유효한 지표값 없음',
           'missing_sessions': '거래일 누락', 'stale_data': '기준일 일봉 미수집', 'quality_records_missing': '품질 기록 누락',
           'quarantined_ohlc': '격리 일봉 포함', 'invalid_ohlc': '가격 데이터 오류', 'invalid_volume': '거래량 누락 또는 오류',
           'symbol_not_found': '수집 목록에 없는 종목', 'screen_timeout': '조회 시간 제한'}


class ScreenEngine:
    def __init__(self):
        self.lock, self.scanners = Lock(), OrderedDict()

    def close(self):
        with self.lock:
            for scanner in self.scanners.values(): scanner.close()
            self.scanners.clear()

    def scan(self, settings, query, now):
        context = market_context(now, settings.calendar_through)
        if not self.lock.acquire(timeout=0.05): raise ScanBusy()
        try:
            metrics = metrics_for(query)
            crossing = any(c.operator.startswith('crosses_') for c in query.conditions)
            signature = (tuple(m.model_dump_json() for m in metrics.values()), crossing, VERSION)
            if signature not in self.scanners:
                if len(self.scanners) >= 8:
                    _, old = self.scanners.popitem(last=False); old.close()
                def evaluate(rows):
                    candles = bars_from_rows(rows)
                    values, previous = {}, {}
                    for k, m in metrics.items():
                        latest, prior = latest_pair(candles, m)
                        if latest is None or not math.isfinite(latest) or (crossing and (prior is None or not math.isfinite(prior))):
                            raise ValueError('indicator_unavailable')
                        values[k], previous[k] = latest, prior
                    return {'values': values, 'previous': previous}
                required = max(warmup(m) for m in metrics.values()) + int(crossing)
                self.scanners[signature] = RsiScreener(evaluator=evaluate, required_bars=required,
                                                        allow_zero_volume=any(isinstance(m, AdvancedMetric) for m in metrics.values()))
            self.scanners.move_to_end(signature)
            data = self.scanners[signature].scan(settings, query.market, context['latest_completed'])
            if query.snapshot_id is not None and query.snapshot_id != data['data_version']:
                raise ScreenSnapshotChanged()
            return data, context
        finally:
            self.lock.release()

    def lookup(self, settings, query, now):
        context = market_context(now, settings.calendar_through)
        cutoff = context['latest_completed']
        metrics = {key(metric): metric for metric in query.metrics}

        def evaluate(rows):
            candles = bars_from_rows(rows)
            found, unavailable = [], []
            for metric in metrics.values():
                info = {'metric': key(metric), 'name': metric.name, 'label': label(metric), 'unit': metric_unit(metric.name)}
                value, previous = latest_pair(candles, metric)
                if value is None or not math.isfinite(value):
                    reason = 'insufficient_warmup' if len(rows) < warmup(metric) else 'indicator_unavailable'
                    unavailable.append({**info, 'reason': REASONS[reason], 'code': reason})
                else:
                    found.append({**info, 'value': value, 'previous': previous if previous is not None and math.isfinite(previous) else None})
            return {'metrics': found, 'unavailable': unavailable, 'seed_date': rows[0][1],
                    'previous_date': rows[-2][1] if len(rows) > 1 else None}

        reader = RsiScreener(evaluator=evaluate, required_bars=1, allow_zero_volume=True)
        try:
            data = reader.scan(settings, 'ALL', cutoff, symbol=query.code)
        finally:
            reader.close()
        subject = data.get('subject', {'code': query.code, 'name': query.code, 'market': ''})
        row = data['items'][0] if data['items'] else {}
        excluded = data['excluded'] or ({'symbol_not_found' if not data['universe'] else 'screen_timeout': 1} if not row else {})
        coverage = {'kind': 'indicator', **subject, 'as_of': cutoff, 'bars': row.get('bars', 0), 'seed_date': row.get('seed_date'),
                    'previous_date': row.get('previous_date'), 'excluded': excluded, 'unavailable': row.get('unavailable', []),
                    'calculation_version': VERSION, 'data_version': data['data_version'], 'calendar_source': context['calendar_source']}
        items = []
        for value in row.get('metrics', []):
            item = {**value, **subject, 'as_of': cutoff, 'source': '실험실 확정 일봉 DB / ' + VERSION}
            if value['name'] in ('supertrend_direction', 'supertrend_flip'):
                meaning = metric_spec(value['name'])['states'][str(int(value['value']))]
            else:
                meaning = f"{value['value']:.4f}{value['unit']}"
            item['excerpt'] = f"{subject['name']}({subject['code']}), 확정 일봉 {cutoff}, {value['label']} = {meaning}"
            if value['name'] in ('obv', 'obv_ma'):
                item['excerpt'] += f" (누적 시작 {row['seed_date']})"
            item['id'] = 'i_' + digest(item)
            items.append(item)
        status = 'empty' if not items else 'partial' if coverage['unavailable'] else 'success'
        return {'status': status, 'items': items, 'coverage': coverage, 'as_of': cutoff, 'source': '실험실 확정 일봉 DB',
                'result_id': 's_' + digest([coverage, [item['id'] for item in items]]),
                'warnings': ['실험실에 수집된 확정 일봉 기준입니다. 장중·분봉 또는 사용자 차트 설정을 조회하지 않습니다.', context['warning']]}

    def execute(self, settings, query, now, snapshot=None):
        data, context = snapshot if snapshot is not None else self.scan(settings, query, now)
        if query.snapshot_id is not None and query.snapshot_id != data['data_version']:
            raise ScreenSnapshotChanged()
        normalized = query.model_dump()
        normalized['snapshot_id'] = data['data_version']
        query_definition = {k: v for k, v in normalized.items() if k not in ('page', 'page_size', 'snapshot_id')}
        query_id = digest([query_definition, data['data_version'], VERSION, CONDITION_VERSION])
        matches = []
        for row in data['items']:
            checks = []
            for c in query.conditions:
                left, pl = row['values'][key(c.left)], row['previous'][key(c.left)]
                base = None if c.right.kind == 'constant' else row['values'][key(c.right.metric)]
                previous_base = None if c.right.kind == 'constant' else row['previous'][key(c.right.metric)]
                right = c.right.value if c.right.kind == 'constant' else base * c.right.factor
                pr = c.right.value if c.right.kind == 'constant' else previous_base
                if pr is not None and c.right.kind == 'metric': pr *= c.right.factor
                checks.append({'label': condition_label(c), 'left': left, 'right': right, 'previous_left': pl,
                               'previous_right': pr, 'right_base': base, 'previous_right_base': previous_base,
                               'factor': c.right.factor, 'ratio_percent': percent(c.right.factor) if c.right.kind == 'metric' and ratio_comparison(c.left.name,c.right.metric.name) else None,
                               'unit':metric_unit(c.left.name), 'matched': compare(c.operator, left, right, pl, pr)})
            accepted = all(c['matched'] for c in checks) if query.match == 'all' else any(c['matched'] for c in checks)
            if accepted:
                item = {k: row[k] for k in ('code', 'name', 'market', 'bars', 'values')}
                item.update(close=row['values']['close'], volume=row['values']['volume'], checks=checks,
                            as_of=context['latest_completed'], source='실험실 일봉 DB / ' + VERSION)
                excerpt = f"{row['name']}({row['code']}), 확정 일봉 {context['latest_completed']}, {query.match} 조건검색 일치 ({sum(c['matched'] for c in checks)}/{len(checks)} 충족)"
                for i, c in enumerate(checks):
                    detail = f"; {c['label']}: {c['left']:.4f} / {c['right']:.4f}"
                    if len(excerpt + detail) > 270:
                        excerpt += f"; 나머지 {len(checks)-i}조건은 상세 수치 참조"
                        break
                    excerpt += detail
                # Claim.excerpt has a 300-character evidence limit. Do not cut a
                # numeric token mid-value or make complex screens impossible to cite.
                item['excerpt'] = excerpt
                item['id'] = 'f_' + digest([query_id, item])
                matches.append(item)
        matches.sort(key=(lambda r: (-r['close'], r['code'])) if query.sort == 'close_desc' else lambda r: r['code'])
        page = matches[(query.page-1)*query.page_size:query.page*query.page_size]
        coverage = {k: data[k] for k in ('universe', 'scanned', 'valid', 'excluded', 'data_version', 'data_read_at', 'cache_hit', 'resumed')}
        coverage.update(kind='screen', market=query.market, not_scanned=data['universe']-data['scanned'],
                        matches=len(matches), returned=len(page), page=query.page, page_size=query.page_size,
                        as_of=context['latest_completed'], sort=query.sort, calculation_version=VERSION,
                        calendar_source=context['calendar_source'], match=query.match, condition_version=CONDITION_VERSION)
        return {'status': 'partial' if coverage['not_scanned'] or data['excluded'] else 'success' if matches else 'empty',
                'items': page, 'coverage': coverage, 'query': normalized, 'query_id': query_id,
                'result_id': 's_' + digest([query_id, coverage, [r['id'] for r in page]]),
                'snapshot_id': data['data_version'], 'columns': [{'key': k, 'name': m.name, 'label': label(m), 'unit': metric_unit(m.name)} for k, m in metrics_for(query).items()],
                'as_of': context['latest_completed'], 'source': '실험실 일봉 DB',
                'warnings': ['수집된 종목의 확정 일봉 기준입니다. 장중 실시간 조건검색이 아닙니다.',
                             '표시 수치는 반올림되며 조건 판정은 반올림 전 수치로 수행합니다.', context['warning']]}


SCREEN_ENGINE = ScreenEngine()
