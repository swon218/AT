"""Fixed authenticated Node read boundary. No broker credentials enter Python."""
import json
from urllib.parse import urlsplit
import httpx


class DataError(Exception):
    pass


class NodeResearchData:
    def __init__(self, settings, request_id, transport=None):
        target = urlsplit(settings.callback_url)
        if target.scheme != 'http' or target.hostname not in ('127.0.0.1', 'localhost') or target.path != '/api/internal/agent/events':
            raise ValueError('invalid_internal_data_url')
        self.settings, self.request_id, self.transport = settings, request_id, transport
        self.url = settings.callback_url.removesuffix('/events') + '/data'

    async def read(self, tool, arguments, budget, maximum=1):
        allowance = min(maximum, budget.settings.external_requests - budget.external)
        if allowance < 1:
            raise DataError('external_request_limit')
        for _ in range(allowance):
            budget.spend_external()
        try:
            async with httpx.AsyncClient(timeout=self.settings.tool_seconds, trust_env=False, transport=self.transport) as client:
                async with client.stream('POST', self.url, headers={'X-Atlas-Internal': self.settings.internal_secret},
                                         json={'request_id': self.request_id, 'tool': tool, 'arguments': arguments, 'max_calls': allowance}) as response:
                    if response.status_code != 200:
                        raise DataError({401:'internal_data_auth_error',409:'request_not_active'}.get(response.status_code,'data_unavailable'))
                    body = b''
                    async for chunk in response.aiter_bytes():
                        body += chunk
                        if len(body) > 150000:
                            raise DataError('data_response_too_large')
            value = json.loads(body)
            spent = value.get('external_requests')
            if not isinstance(spent, int) or isinstance(spent, bool) or not 0 <= spent <= allowance:
                raise DataError('invalid_data_response')
            budget.external -= allowance - spent
            if value.get('status') not in ('success','partial','empty','error'):
                raise DataError('invalid_data_response')
            return value
        except httpx.TimeoutException:
            raise DataError('data_timeout') from None
        except (httpx.HTTPError, ValueError, TypeError):
            raise DataError('data_unavailable') from None


async def read_data(tools, name, args, maximum=1):
    if tools.data is None:
        raise DataError('data_source_unavailable')
    return await tools.data.read(name, args.model_dump(), tools.budget, maximum)
