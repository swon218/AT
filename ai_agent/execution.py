"""Request-wide model reservations and ordered, public execution events."""
import asyncio
import json
import time

from .provider import ProviderError
from .roles import ARCHITECTURE

TOKEN_KEYS = ('input_tokens', 'output_tokens', 'reasoning_tokens', 'cached_tokens')


class RunLimit(Exception):
    pass


class RunStopped(Exception):
    pass


def usage():
    return {**dict.fromkeys(TOKEN_KEYS, 0), 'status': 'known', 'model_calls': 0, 'budget_usd': 0.0}


class Execution:
    def __init__(self, settings, provider, on_step):
        self.settings, self.provider, self.on_step = settings, provider, on_step
        self.started = time.monotonic()
        self.usage, self.role_usage = usage(), {}
        self.steps, self.reserved = [], {}
        self.tool_calls = 0
        self.event_lock = asyncio.Lock()
        self.stopped = False

    def cost(self, inputs, outputs):
        return (inputs * self.settings.input_usd_per_million + outputs * self.settings.output_usd_per_million) / 1_000_000

    async def event(self, kind, name, status, agent, arguments=None, result=None, elapsed=0, snapshot_usage=False):
        async with self.event_lock:
            if self.stopped:
                raise RunStopped()
            result = dict(result or {})
            if snapshot_usage:
                result.update(usage_status=self.usage['status'], usage_total=dict(self.usage))
            step = {'seq': len(self.steps) + 1, 'kind': kind, 'name': name, 'status': status,
                    'agent': agent, 'architecture': ARCHITECTURE, 'arguments': arguments or {},
                    'result': result, 'elapsed_ms': max(0, int(elapsed * 1000))}
            self.steps.append(step)
            if self.on_step:
                try:
                    await self.on_step(step)
                except Exception as exc:
                    self.stopped = True
                    raise RunStopped() from exc

    def reserve(self, items, instructions, tools):
        # Reservation and settlement have no await points. Every branch shares this event loop.
        settings = self.settings
        if self.stopped:
            raise RunStopped()
        if self.usage['status'] == 'unknown':
            raise RunLimit('usage_unknown')
        if self.usage['model_calls'] + len(self.reserved) >= settings.rounds:
            raise RunLimit('model_round_limit')
        reserved_tokens = sum(tokens for tokens, _ in self.reserved.values())
        reserved_cost = sum(cost for _, cost in self.reserved.values())
        input_bound = len(json.dumps([items, instructions, tools], ensure_ascii=False).encode()) + 4096
        available = settings.tokens - self.usage['input_tokens'] - self.usage['output_tokens'] - reserved_tokens
        output = min(settings.output_tokens, available - input_bound)
        cost_bound = self.cost(input_bound, max(output, 0))
        if output < 256 or self.usage['budget_usd'] + reserved_cost + cost_bound > settings.max_usd:
            raise RunLimit('token_or_cost_limit')
        ticket = object()
        self.reserved[ticket] = (input_bound + output, cost_bound)
        return ticket, output

    def settle(self, ticket, role, actual):
        reserved_tokens, reserved_cost = self.reserved.pop(ticket)
        for totals in (self.usage, role):
            totals['model_calls'] += 1
            if actual is None:
                totals['status'] = 'unknown'
                totals['uncertain_usd_bound'] = totals.get('uncertain_usd_bound', 0) + reserved_cost
                totals['uncertain_tokens_bound'] = totals.get('uncertain_tokens_bound', 0) + reserved_tokens
            else:
                for key in TOKEN_KEYS:
                    totals[key] += actual.get(key, 0)
                totals['budget_usd'] += self.cost(actual['input_tokens'], actual['output_tokens'])

    async def model(self, agent, items, instructions, tools):
        ticket, output = self.reserve(items, instructions, tools)
        role = self.role_usage.setdefault(agent, usage())
        started = time.monotonic()
        dispatched = False
        try:
            await self.event('model', 'responses', 'started', agent)
            if self.usage['status'] == 'unknown':
                raise RunLimit('usage_unknown')
            dispatched = True
            turn = await self.provider.respond(items, instructions, tools, output)
            self.settle(ticket, role, turn.usage)
        except ProviderError as exc:
            self.settle(ticket, role, None if exc.code != 'api_key_missing' else dict.fromkeys(TOKEN_KEYS, 0))
            await self.event('model', 'responses', 'error', agent, result={'code': exc.code},
                             elapsed=time.monotonic() - started, snapshot_usage=True)
            raise RunLimit(exc.code) from None
        finally:
            if ticket in self.reserved:
                if dispatched:
                    self.settle(ticket, role, None)
                else:
                    del self.reserved[ticket]
            if dispatched:
                role['elapsed_ms'] = role.get('elapsed_ms', 0) + round((time.monotonic() - started) * 1000)
        await self.event('model', 'responses', 'success', agent, result={'usage': turn.usage, 'agent_usage': dict(role)},
                         elapsed=time.monotonic() - started, snapshot_usage=True)
        if turn.usage is None:
            raise RunLimit('usage_unknown')
        if self.usage['input_tokens'] + self.usage['output_tokens'] > self.settings.tokens or self.usage['budget_usd'] > self.settings.max_usd:
            raise RunLimit('token_or_cost_limit')
        if not turn.complete:
            raise RunLimit('incomplete_model_response')
        return turn

    def tool_slot(self):
        if self.tool_calls >= self.settings.tool_calls:
            raise RunLimit('tool_call_limit')
        self.tool_calls += 1
        self.usage['tool_calls'] = self.tool_calls
