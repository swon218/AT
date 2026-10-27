"""Provider adapter: no implicit SDK retries, no fallback model, no prompt logging."""
import json
import httpx
from dataclasses import dataclass
from openai import AsyncOpenAI, APIConnectionError, APIStatusError, APITimeoutError
from .schemas import Final


class ProviderError(Exception):
    def __init__(self, code, retryable=False):
        self.code, self.retryable = code, retryable


@dataclass
class Turn:
    output: list
    text: str
    usage: dict | None
    complete: bool = True


class OpenAIProvider:
    def __init__(self, settings, client=None):
        self.settings = settings
        self.client = client or (AsyncOpenAI(api_key=settings.api_key, max_retries=0, timeout=35,
                                           base_url='https://api.openai.com/v1', http_client=httpx.AsyncClient(timeout=35, trust_env=False))
                                 if settings.api_key else None)

    async def respond(self, items, instructions, tools, output_limit):
        if not self.client:
            raise ProviderError('api_key_missing')
        try:
            response = await self.client.responses.create(
                model=self.settings.model, input=items, instructions=instructions, tools=tools,
                parallel_tool_calls=False, max_output_tokens=output_limit,
                store=False, include=['reasoning.encrypted_content'],
                text={'format': {'type': 'json_schema', 'name': 'atlas_research',
                                 'strict': True, 'schema': Final.model_json_schema()}},
            )
            usage = None
            if response.usage:
                u = response.usage
                usage = {'input_tokens': u.input_tokens, 'output_tokens': u.output_tokens,
                         'reasoning_tokens': getattr(u.output_tokens_details, 'reasoning_tokens', 0) or 0,
                         'cached_tokens': getattr(u.input_tokens_details, 'cached_tokens', 0) or 0}
            # All response.output items (including opaque reasoning continuation) stay in RAM only.
            return Turn([item.model_dump(exclude_none=True) for item in response.output],
                        response.output_text, usage, response.status == 'completed')
        except (APIConnectionError, APITimeoutError):
            raise ProviderError('connection_failed') from None  # billing unknown; never blindly replay
        except APIStatusError as exc:
            code = {401: 'authentication_error', 403: 'permission_error', 402: 'billing_error',
                    429: 'billing_or_rate_limit'}.get(exc.status_code, 'provider_error')
            raise ProviderError(code) from None
