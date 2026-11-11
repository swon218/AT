"""Shared unit/comparison policy. Never changes indicator arithmetic or saved factors."""
import json
from decimal import Decimal
from pathlib import Path

CATALOG = json.loads((Path(__file__).resolve().parents[1] / 'shared/screener-metrics.json').read_text(encoding='utf-8'))
VERSION = CATALOG['version']


def metric_spec(name):
    item = CATALOG['metrics'][name]
    return {**CATALOG['groups'][item['group']], **item}


def ratio_comparison(left, right):
    a, b = metric_spec(left), metric_spec(right)
    return a['group'] == b['group'] and a['ratio']


def percent(factor):
    return float(Decimal(str(factor)) * 100)


def condition_error(condition):
    m, operand = metric_spec(condition.left.name), condition.right
    if 'states' in m:
        if operand.kind != 'constant' or operand.factor != 1 or str(int(operand.value)) not in m['states'] or int(operand.value) != operand.value:
            return 'screen_state_comparison'
    elif condition.operator == 'eq':
        return 'screen_state_operator'
    if operand.kind == 'metric' and m['group'] != metric_spec(operand.metric.name)['group']:
        return 'screen_unit_mismatch'
    if operand.kind == 'constant' and 'states' not in m and not m['min'] <= operand.value <= m['max']:
        return 'screen_threshold_range'
    return None


def validation_code(errors):
    allowed = {'screen_state_comparison', 'screen_state_operator', 'screen_unit_mismatch', 'screen_threshold_range'}
    for error in errors:
        value = str(error.get('ctx', {}).get('error', ''))
        if value in allowed:
            return value
    return 'invalid_screen_query'
