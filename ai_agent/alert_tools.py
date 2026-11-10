from datetime import timedelta
from decimal import Decimal
import re

from .market import KST


ALERT_NEXT_STEP = ('If the member asked to create or edit an alert and the symbol and condition are clear, call propose_alert. '
                   'A unique symbol outside the watchlist is eligible. The tool result creates the confirmation card. '
                   'Ask a clarification only for a missing or ambiguous detail. A stock lookup alone is not an alert request.')


def normalize_stock_symbol(value):
    normalized = ''.join(value.upper().split())
    if re.fullmatch(r'A\d{6}', normalized):
        return normalized[1:]
    return {'네이버': 'NAVER'}.get(normalized, normalized)


class AlertTools:
    def __init__(self, context, now):
        self.available = context is not None
        self.watchlist = (context or {}).get('watchlist', [])[:20]
        self.rules = [rule for rule in (context or {}).get('rules', []) if rule.get('rule_id')]
        self.draft = (context or {}).get('draft')
        self.today = now.astimezone(KST).date()

    def resolve(self, symbol):
        normalized = normalize_stock_symbol(symbol)
        return [row for row in self.watchlist
                if normalized in (row['code'], normalize_stock_symbol(row['name']))]

    def editor(self):
        return {'status': 'success', 'items': self.watchlist,
                'saved': [{k: v for k, v in rule.items() if k != 'version'} for rule in self.rules],
                'draft': {k: v for k, v in self.draft.items() if k != 'id'} if self.draft else None,
                'login_required': not self.available,
                **({'next_step': ALERT_NEXT_STEP} if self.available else {})}

    def status(self, args):
        if not self.available:
            return {'kind': 'unavailable'}
        if args.symbol is None:
            return {'kind': 'status', 'code': None}
        matches = self.resolve(args.symbol)
        if len(matches) != 1:
            return {'kind': 'ambiguous' if matches else 'watchlist_required'}
        return {'kind': 'status', 'code': matches[0]['code']}

    def propose(self, args, question, lookup=None):
        if not self.available:
            return {'kind': 'unavailable'}
        # Defence in depth for explicitly named unsupported reference prices.
        explicit = re.search(r'(?:매입가|매수가|평균단가|고점|저점|현재\s*시점|시가)\s*(?:대비|기준)(?!\s*(?:말고|아니))', question)
        if args.basis == 'unsupported' or explicit:
            return {'kind': 'unsupported'}
        edit_draft = args.action == 'edit'
        edit_saved = args.action == 'edit_saved'
        if edit_draft and not self.draft:
            return {'kind': 'ambiguous'}
        stock = None
        if args.symbol:
            matches = self.resolve(args.symbol)
            if not matches and args.action == 'create' and lookup is not None:
                matches = lookup(args.symbol)
                if not matches:
                    return {'kind': 'symbol_not_found'}
            if len(matches) != 1:
                return {'kind': 'symbol_candidates', 'candidates': matches} if matches else {'kind': 'watchlist_required'}
            stock = matches[0]
            code = stock['code']
        elif edit_draft:
            code = self.draft['code']
        else:
            return {'kind': 'ambiguous'}
        if edit_draft and code != self.draft['code']:
            return {'kind': 'ambiguous'}
        target = None
        if edit_saved:
            target = next((rule for rule in self.rules if rule['code'] == code and rule['rule_id'] == args.rule_id), None)
            if target is None:
                return {'kind': 'ambiguous_rule', 'code': code}
        old = target or (self.draft if edit_draft else {})
        if old.get('kind') in ('price_gte', 'price_lte') and args.kind != 'price_touch':
            return {'kind': 'legacy_conversion_required'}
        kind = args.kind or old.get('kind')
        threshold = args.threshold if args.threshold is not None else old.get('threshold')
        expires_on = args.expires_on or (old.get('expires_on') if old else (self.today + timedelta(days=7)).isoformat())
        frequency = args.frequency or old.get('frequency') or 'once'
        if kind not in ('price_touch', 'rise_gte', 'fall_lte') or threshold is None or expires_on is None:
            return {'kind': 'invalid'}
        price = kind.startswith('price')
        basis = 'price' if price else 'previous_close'
        if args.basis != basis and not (old and args.basis == 'same' and kind == old.get('kind')):
            return {'kind': 'invalid'}
        magnitude = Decimal(str(threshold))
        if price and (magnitude < 1 or magnitude != int(magnitude)) or not price and (
            magnitude > 100 or magnitude != magnitude.quantize(Decimal('0.01'))
        ):
            return {'kind': 'invalid'}
        if not self.today.isoformat() <= expires_on <= (self.today + timedelta(days=30)).isoformat():
            return {'kind': 'invalid'}
        rule = {'code': code, 'kind': kind, 'threshold': threshold, 'expires_on': expires_on, 'frequency': frequency}
        if args.action == 'create' and not any(row['code'] == code for row in self.watchlist):
            return {'kind': 'watchlist_confirmation', 'stock': stock, 'rule': rule}
        return {'kind': 'draft', 'edit': edit_draft,
                **({'rule_id': target['rule_id'], 'version': target['version']} if target else {}),
                'rule': rule}
