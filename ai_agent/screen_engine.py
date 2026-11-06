"""One read-only daily screen engine for manual UI and AI function calls."""
from collections import OrderedDict
import hashlib
import json
import math
from threading import Lock
from .indicators import VERSION, key, label, condition_label, latest_pair, warmup, compare
from .market import market_context
from .screener import RsiScreener, ScanBusy, ScanChanged


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
                    candles = [{'time': r[1], 'close': r[2], 'open': r[4], 'high': r[5], 'low': r[6], 'volume': r[7]} for r in rows]
                    values, previous = {}, {}
                    for k, m in metrics.items():
                        latest, prior = latest_pair(candles, m)
                        if latest is None or not math.isfinite(latest) or (crossing and (prior is None or not math.isfinite(prior))):
                            raise ValueError('indicator_unavailable')
                        values[k], previous[k] = latest, prior
                    return {'values': values, 'previous': previous}
                required = max(warmup(m) for m in metrics.values()) + int(crossing)
                self.scanners[signature] = RsiScreener(evaluator=evaluate, required_bars=required)
            self.scanners.move_to_end(signature)
            data = self.scanners[signature].scan(settings, query.market, context['latest_completed'])
            if query.snapshot_id is not None and query.snapshot_id != data['data_version']:
                raise ScreenSnapshotChanged()
            return data, context
        finally:
            self.lock.release()

    def execute(self, settings, query, now, snapshot=None):
        data, context = snapshot if snapshot is not None else self.scan(settings, query, now)
        if query.snapshot_id is not None and query.snapshot_id != data['data_version']:
            raise ScreenSnapshotChanged()
        normalized = query.model_dump()
        normalized['snapshot_id'] = data['data_version']
        query_definition = {k: v for k, v in normalized.items() if k not in ('page', 'page_size', 'snapshot_id')}
        query_id = digest([query_definition, data['data_version'], VERSION])
        matches = []
        for row in data['items']:
            checks = []
            for c in query.conditions:
                left, pl = row['values'][key(c.left)], row['previous'][key(c.left)]
                right = c.right.value if c.right.kind == 'constant' else row['values'][key(c.right.metric)] * c.right.factor
                pr = c.right.value if c.right.kind == 'constant' else row['previous'][key(c.right.metric)]
                if pr is not None and c.right.kind == 'metric': pr *= c.right.factor
                checks.append({'label': condition_label(c), 'left': left, 'right': right, 'previous_left': pl,
                               'previous_right': pr, 'matched': compare(c.operator, left, right, pl, pr)})
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
                        calendar_source=context['calendar_source'], match=query.match)
        return {'status': 'partial' if coverage['not_scanned'] or data['excluded'] else 'success' if matches else 'empty',
                'items': page, 'coverage': coverage, 'query': normalized, 'query_id': query_id,
                'result_id': 's_' + digest([query_id, coverage, [r['id'] for r in page]]),
                'snapshot_id': data['data_version'], 'columns': [{'key': k, 'label': label(m)} for k, m in metrics_for(query).items()],
                'as_of': context['latest_completed'], 'source': '실험실 일봉 DB',
                'warnings': ['수집된 종목의 확정 일봉 기준입니다. 장중 실시간 조건검색이 아닙니다.',
                             '표시 수치는 반올림되며 조건 판정은 반올림 전 수치로 수행합니다.', context['warning']]}


SCREEN_ENGINE = ScreenEngine()
