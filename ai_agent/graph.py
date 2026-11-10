"""The production and evaluation entry point. No checkpoint replay of paid calls or writes."""
import asyncio
import copy
import json
import operator
import time
from typing import Annotated
from typing_extensions import TypedDict
from langgraph.graph import StateGraph, START, END
from langgraph.types import RetryPolicy, Send
from langsmith import tracing_context

from .alert_tools import ALERT_NEXT_STEP
from .answers import (materialize, validate_final, VALIDATION_CODES, VALIDATION_HINTS, WATCHLIST_APPROVAL)
from .execution import Execution, RunLimit, RunStopped
from .roles import ARCHITECTURE, DELEGATE, Delegation, ORCHESTRATOR, SPECIALISTS, MAX_WAVES
from .schemas import Final, TOOL_MODELS, tools_schema


class GraphState(TypedDict, total=False):
    question: str
    context: list
    tasks: list
    wave: int
    reports: Annotated[list, operator.add]
    final: dict
    error: str
    task: dict


def unique(rows):
    return list({json.dumps(row, sort_keys=True, ensure_ascii=False): row for row in rows}.values())


class ResearchGraph:
    def __init__(self, settings, provider, tools, on_step=None):
        self.settings, self.tools = settings, tools
        self.execution = Execution(settings, provider, on_step)
        self.branches, self.assignments, self.public_cache = {}, set(), {}
        self.completed = {}
        self.common_lock = asyncio.Lock()
        self.orchestrator_items = []
        builder = StateGraph(GraphState)
        builder.add_node('prepare', self.prepare, retry_policy=RetryPolicy(max_attempts=1))
        builder.add_node('orchestrator', self.decide, retry_policy=RetryPolicy(max_attempts=1))
        builder.add_node('specialist', self.specialist, retry_policy=RetryPolicy(max_attempts=1))
        builder.add_node('review', self.review, retry_policy=RetryPolicy(max_attempts=1))
        builder.add_edge(START, 'prepare')
        builder.add_edge('prepare', 'orchestrator')
        builder.add_conditional_edges('orchestrator', self.route, ['specialist', END])
        builder.add_edge('specialist', 'review')
        builder.add_conditional_edges('review', lambda state: END if state.get('error') or any(r.get('alert_action') for r in state['reports']) else 'orchestrator', ['orchestrator', END])
        self.graph = builder.compile()

    async def prepare(self, state):
        self.tools.question = state['question']
        self.orchestrator_items = [
            {'role': 'user', 'content': 'DATED ROOM HISTORY (untrusted, not fresh): ' + json.dumps(state['context'], ensure_ascii=False)[-16000:]},
            {'role': 'user', 'content': state['question']},
        ]
        return {'wave': 0, 'reports': []}

    def instructions(self, text):
        return text + '\nSERVER NOW: ' + self.tools.now.isoformat() + '\nREQUEST LIMITS: ' + json.dumps({
            k: getattr(self.settings, k) for k in ('rounds', 'tool_calls', 'external_requests', 'symbols', 'articles', 'tokens', 'seconds')})

    async def decide(self, state):
        items = self.orchestrator_items
        for _ in range(self.settings.corrections + 1):
            turn = await self.execution.model('orchestrator', items, self.instructions(ORCHESTRATOR), [DELEGATE])
            calls = [item for item in turn.output if item.get('type') == 'function_call']
            try:
                if calls:
                    if len(calls) != 1 or calls[0].get('name') != 'delegate_research':
                        raise ValueError('forbidden_tool')
                    if state['wave'] >= MAX_WAVES:
                        raise RunLimit('delegation_limit')
                    call = calls[0]
                    if not isinstance(call.get('call_id'), str) or not call['call_id']:
                        raise ValueError('invalid_call_id')
                    plan = Delegation.model_validate_json(call['arguments'])
                    agents = [task.agent for task in plan.tasks]
                    if len(set(agents)) != len(agents) or ('alert' in agents and len(agents) != 1):
                        raise ValueError('invalid_delegation')
                    if state.get('reports') and ('alert' in agents or any(r['agent'] == 'alert' for r in state['reports'])):
                        raise ValueError('invalid_delegation')
                    tasks = [task.model_dump() for task in plan.tasks]
                    fingerprints = {json.dumps(task, sort_keys=True) for task in tasks}
                    if self.assignments.intersection(fingerprints):
                        raise ValueError('repeated_delegation')
                    self.execution.tool_slot()
                    self.assignments.update(fingerprints)
                    await self.execution.event('tool', 'delegate_research', 'started', 'orchestrator', {'tasks': tasks})
                    self.delegation_call = call['call_id']
                    items.extend(turn.output)
                    return {'tasks': tasks, 'wave': state['wave'] + 1}
                final = Final.model_validate_json(turn.text)
                if WATCHLIST_APPROVAL.search(final.summary):
                    raise ValueError('alert_proposal_required')
                validate_final(final, self.tools, state['question'])
                if final.kind == 'insufficient' and state.get('reports') and all(r['status'] == 'failed' for r in state['reports']):
                    return {'error': state['reports'][0]['error_codes'][-1], 'tasks': []}
                await self.execution.event('validation', 'final', 'success', 'orchestrator')
                return {'final': final.model_dump(), 'tasks': []}
            except ValueError as exc:
                code = str(exc)
                if code not in VALIDATION_CODES | {'forbidden_tool', 'invalid_delegation', 'invalid_call_id', 'repeated_delegation'}:
                    code = 'invalid_delegation' if calls else 'invalid_final_schema'
                await self.execution.event('validation', 'final', 'error', 'orchestrator', result={'code': code})
                if items[-1].get('role') == 'developer':
                    items.pop()
                items.append({'role': 'developer', 'content': 'SERVER VALIDATION [' + code + ']. ' + VALIDATION_HINTS.get(code, 'Use a valid delegation or a supported final response.')})
        return {'error': 'answer_validation_failed', 'tasks': []}

    def route(self, state):
        if state.get('final') or state.get('error'):
            return END
        return [Send('specialist', {'question': state['question'], 'task': task, 'wave': state['wave']}) for task in state['tasks']]

    def branch(self, agent):
        # Private member state is only exposed to Alert Planning. Public evidence may flow between waves.
        tools = copy.copy(self.tools)
        tools.agent = agent
        tools.evidence = {key: dict(value) for key, value in self.tools.evidence.items()
                          if key.startswith(SPECIALISTS[agent].evidence_prefixes)}
        tools.resolved = dict(self.tools.resolved)
        tools.fresh_ids = set(self.tools.fresh_ids).intersection(tools.evidence)
        tools.coverage, tools.result_sets = [], []
        previous = self.branches.get(agent)
        tools.rsi_snapshots = dict(previous.rsi_snapshots) if previous else {}
        tools.stock_snapshots = dict(previous.stock_snapshots) if previous else {}
        tools.alert_action = None
        if agent != 'alert':
            from .alert_tools import AlertTools
            tools.alerts = AlertTools(None, tools.now)
        self.branches[agent] = tools
        return tools

    async def execute_tool(self, agent, tools, name, arguments, seen):
        self.execution.tool_slot()
        role_usage = self.execution.role_usage.setdefault(agent, {})
        role_usage['tool_calls'] = role_usage.get('tool_calls', 0) + 1
        allowed = SPECIALISTS[agent].tools
        try:
            if name not in allowed:
                raise ValueError('forbidden_tool')
            parsed = TOOL_MODELS[name].model_validate_json(arguments).model_dump()
        except (KeyError, ValueError):
            result = tools.error('forbidden_tool' if name not in allowed else 'invalid_arguments')
            await self.execution.event('tool', name if name in allowed else 'forbidden', 'error', agent, result={'code': result['code']})
            return result
        fingerprint = (name, json.dumps(parsed, sort_keys=True))
        await self.execution.event('tool', name, 'started', agent, parsed)
        started = time.monotonic()
        external_before = tools.budget.external
        if fingerprint in seen:
            result = tools.error('repeated_tool_call')
        else:
            seen.add(fingerprint)
            if name in ('resolve_symbol', 'get_market_context'):
                async with self.common_lock:
                    if fingerprint not in self.public_cache:
                        self.public_cache[fingerprint] = await tools.execute(name, arguments)
                    result = copy.deepcopy(self.public_cache[fingerprint])
                    if name == 'resolve_symbol' and len(result.get('items', [])) == 1:
                        row = result['items'][0]
                        tools.resolved[row['code']] = row
            else:
                result = await tools.execute(name, arguments)
        safe = {key: result[key] for key in ('status', 'code', 'as_of', 'coverage', 'result_id') if key in result}
        safe['references'] = [item['id'] for item in result.get('items', []) if 'id' in item][:20]
        safe['count'] = len(result.get('items', []))
        role_usage['external_requests'] = role_usage.get('external_requests', 0) + tools.budget.external - external_before
        self.execution.usage['external_requests'] = tools.budget.external
        await self.execution.event('tool', name, result['status'], agent, result=safe, elapsed=time.monotonic() - started, snapshot_usage=True)
        return result

    async def specialist(self, state):
        task, agent = state['task'], state['task']['agent']
        tools = self.branch(agent)
        # No whole conversation or private editor is copied to unrelated specialists.
        items = [{'role': 'user', 'content': json.dumps({'assignment': task, 'request': state['question'] if agent == 'alert' else task['goal'],
                   'verified_symbols': list(tools.resolved.values())[:20],
                   'dated_evidence': list(tools.evidence.values())[:12]}, ensure_ascii=False)}]
        started, seen, failures = time.monotonic(), set(), []
        final = None
        finished = False
        try:
            final = await asyncio.wait_for(
                self.investigate(agent, tools, items, state['question'], seen, failures),
                timeout=min(self.settings.seconds * .75, 70))
            finished = True
        except asyncio.TimeoutError:
            failures.append('specialist_timeout')
        except RunLimit as exc:
            failures.append(str(exc))
        action = tools.alert_action if finished else None
        status = 'success' if final or action else 'failed'
        if final and final.kind == 'clarification':
            status = 'clarification'
        elif final and final.kind == 'insufficient':
            status = 'failed' if failures else 'empty'
        elif tools.fresh_ids and (failures or any(c.get('excluded') or c.get('not_scanned') or c.get('unavailable') or c.get('incomplete') for c in tools.coverage)):
            status = 'partial'
        cited_ids = [claim.evidence_id for claim in final.claims] if final else []
        evidence_ids = list(dict.fromkeys(cited_ids + sorted(tools.fresh_ids)))
        user_confirmation = None
        if final and final.kind == 'clarification':
            user_confirmation = final.summary
        elif action and action['kind'] == 'watchlist_confirmation':
            user_confirmation = '관심종목 추가 확인'
        report = {'agent': agent, 'assignment': task, 'wave': state['wave'], 'status': status,
                  'findings': final.model_dump() if final else None,
                  'evidence_ids': evidence_ids[:120], 'evidence_count': len(evidence_ids),
                  'sources': [tools.evidence[key] for key in evidence_ids[:12]],
                  'matched_symbols': [{'code': row['code'], 'name': row['name']} for result_set in tools.result_sets for row in result_set.get('items', [])][:20],
                  'coverage': tools.coverage, 'queried_at': tools.now.isoformat(),
                  'as_of': unique([{'as_of': source.get('as_of')} for source in tools.evidence.values()]),
                  'error_codes': list(dict.fromkeys(failures)), 'needs_confirmation': bool(action and action['kind'] == 'watchlist_confirmation'),
                  'user_confirmation': user_confirmation,
                  'alert_action': action, 'usage': dict(self.execution.role_usage.get(agent, {})),
                  'elapsed_ms': round((time.monotonic() - started) * 1000)}
        self.completed[(state['wave'], agent)] = (report, tools)
        event_status = 'success'
        if status in ('failed', 'partial'):
            event_status = 'error' if status == 'failed' else 'partial'
        await self.execution.event('validation', 'specialist_result', event_status, agent,
                                   result={key: report[key] for key in ('status', 'error_codes', 'evidence_ids', 'usage')}, elapsed=time.monotonic() - started)
        return {'reports': [report]}

    async def investigate(self, agent, tools, items, question, seen, failures):
        editor_read, symbol_read, final, repairs = False, False, None, 0
        for _ in range(min(self.settings.rounds, 6)):
            turn = await self.execution.model(agent, items, self.instructions(SPECIALISTS[agent].instructions), tools_schema(SPECIALISTS[agent].tools))
            calls = [item for item in turn.output if item.get('type') == 'function_call']
            if calls:
                if len(calls) != 1 or not isinstance(calls[0].get('call_id'), str):
                    raise RunLimit('invalid_call_id')
                items.extend(turn.output)
                call = calls[0]
                result = await self.execute_tool(agent, tools, call.get('name', ''), call.get('arguments', ''), seen)
                if result['status'] == 'error':
                    failures.append(result['code'])
                    if len(failures) > self.settings.corrections:
                        raise RunLimit('tool_recovery_limit')
                if call['name'] == 'get_alert_editor' and result.get('login_required') is False:
                    editor_read = True
                if call['name'] == 'resolve_symbol' and len(result.get('items', [])) == 1:
                    symbol_read = True
                    if agent == 'alert' and editor_read:
                        result = {**result, 'next_step': ALERT_NEXT_STEP}
                items.append({'type': 'function_call_output', 'call_id': call['call_id'], 'output': json.dumps(result, ensure_ascii=False)})
                if tools.alert_action and tools.alert_action['kind'] not in ('ambiguous', 'invalid', 'unsupported'):
                    break
                continue
            try:
                final = Final.model_validate_json(turn.text)
                if agent == 'alert' and final.kind == 'concept' and not tools.alert_action:
                    raise ValueError('alert_proposal_required')
                if (editor_read or symbol_read) and WATCHLIST_APPROVAL.search(final.summary):
                    raise ValueError('alert_proposal_required')
                validate_final(final, tools, question, alert_editor_read=editor_read)
                break
            except ValueError as exc:
                final = None
                repairs += 1
                code = str(exc) if str(exc) in VALIDATION_CODES else 'invalid_final_schema'
                await self.execution.event('validation', 'final', 'error', agent, result={'code': code})
                if repairs > self.settings.corrections:
                    raise RunLimit('answer_validation_failed')
                if items[-1].get('role') == 'developer':
                    items.pop()
                items.append({'role': 'developer', 'content': 'SERVER VALIDATION [' + code + ']. ' + VALIDATION_HINTS.get(code, 'Use verified evidence or clarification.') + (' ' + ALERT_NEXT_STEP if agent == 'alert' else '')})
        else:
            raise RunLimit('specialist_round_limit')
        return final

    def collect(self, reports):
        for report in reports:
            branch = self.completed[(report['wave'], report['agent'])][1]
            for key, source in branch.evidence.items():
                if key in self.tools.evidence and self.tools.evidence[key] != source:
                    # Same content-addressed ID may have a historical flag. Other differences must not overwrite.
                    old = {k: v for k, v in self.tools.evidence[key].items() if k != 'historical'}
                    new = {k: v for k, v in source.items() if k != 'historical'}
                    if old != new:
                        raise RunLimit('evidence_conflict')
                self.tools.evidence[key] = source
            self.tools.fresh_ids.update(branch.fresh_ids)
            self.tools.resolved.update(branch.resolved)
            self.tools.coverage = unique(self.tools.coverage + branch.coverage)
            self.tools.result_sets = unique(self.tools.result_sets + branch.result_sets)

    async def review(self, state):
        reports = sorted([report for report in state['reports'] if report['wave'] == state['wave']], key=lambda r: r['agent'])
        self.collect(reports)
        await self.execution.event('tool', 'delegate_research', 'success', 'orchestrator',
                                   result={'agents': [report['agent'] for report in reports], 'wave': state['wave']})
        self.orchestrator_items.append({'type': 'function_call_output', 'call_id': self.delegation_call,
                                       'output': json.dumps({'reports': reports, 'remaining_batches': MAX_WAVES - state['wave']}, ensure_ascii=False)})
        if self.execution.usage['status'] == 'unknown':
            return {'error': next((report['error_codes'][-1] for report in reports if report['error_codes']), 'usage_unknown')}
        return {}

    def result(self, state, code=None):
        # A global timeout can arrive while a completed peer is waiting at the join.
        reports = [self.completed[key][0] for key in sorted(self.completed)]
        try:
            self.collect(reports)
        except RunLimit as exc:
            code = str(exc)
        action = next((report['alert_action'] for report in reports if report.get('alert_action')), None)
        if action and not code:
            answer = {'content': '알림 조건을 확인해 주세요.', 'claims': [], 'sources': [], 'coverage': [], 'result_sets': [], 'as_of': self.tools.now.isoformat()}
        else:
            final = Final.model_validate(state['final']) if state.get('final') and not code else Final(
                kind='insufficient', summary='조사를 완료하지 못했습니다. 확보된 자료와 미완료 범위를 확인해 주세요.',
                sentiment='자료 부족', claims=[], uncertainty=[code or state.get('error') or 'research_incomplete'])
            answer = materialize(final, self.tools, self.tools.now)
            if not state.get('final'):
                answer['sources'] = [self.tools.evidence[key] for key in sorted(self.tools.fresh_ids)][:12]
                for source in answer['sources']:
                    answer['content'] += '\n\n확보 자료: ' + (source.get('excerpt') or source.get('title', ''))
        incomplete = [report for report in reports if report['status'] in ('failed', 'partial')]
        if incomplete:
            answer['content'] += '\n\n미완료 범위: ' + ', '.join(report['agent'] + ' (' + ', '.join(report['error_codes'] or ['partial_data']) + ')' for report in incomplete)
        missing = [task['agent'] for task in state.get('tasks', []) if (state.get('wave'), task['agent']) not in self.completed]
        if code and missing:
            answer['content'] += '\n\n미완료 담당: ' + ', '.join(missing)
        answer['execution'] = {'architecture': ARCHITECTURE, 'agent_usage': self.execution.role_usage,
                               'elapsed_ms': round((time.monotonic() - self.execution.started) * 1000),
                               'reports': [{key: report[key] for key in ('agent', 'assignment', 'wave', 'status', 'error_codes', 'needs_confirmation', 'queried_at', 'as_of', 'evidence_ids', 'elapsed_ms')} for report in reports]}
        while len(json.dumps(answer, ensure_ascii=False).encode()) > 98000 and answer.get('result_sets'):
            answer['result_sets'].pop(0)
            answer['content'] += '\n저장 크기 제한으로 결과 목록을 생략했습니다. 실행 근거와 범위는 유지됩니다.'
        code = code or state.get('error')
        status = 'completed'
        if code and not self.tools.fresh_ids:
            status = 'failed'
        elif code or incomplete:
            status = 'partial'
        self.execution.usage.update(tool_calls=self.execution.tool_calls, external_requests=self.tools.budget.external)
        return {'status': status, 'answer': answer, 'error_code': code, 'usage': self.execution.usage,
                'steps': self.execution.steps, 'architecture': ARCHITECTURE,
                'agent_results': reports, 'agent_usage': self.execution.role_usage,
                **({'alert_action': action} if action and not code else {})}

    async def run(self, question, context):
        try:
            return await asyncio.wait_for(self._run(question, context), self.settings.seconds)
        except asyncio.TimeoutError:
            return self.result(self.latest_state, 'execution_timeout')

    async def _run(self, question, context):
        state = {'question': question, 'context': context, 'reports': []}
        self.latest_state = state
        try:
            # No managed observability dependency or accidental prompt uploads from tracing env flags.
            with tracing_context(enabled=False):
                async for update in self.graph.astream(state, {'recursion_limit': 12, 'max_concurrency': 2}, stream_mode='updates'):
                    for changes in update.values():
                        if changes:
                            state = {**state, **changes, 'reports': state['reports'] + changes.get('reports', [])}
                            self.latest_state = state
            return self.result(state)
        except RunLimit as exc:
            return self.result(state, str(exc))
        except RunStopped:
            return self.result(state, 'execution_cancelled')
