"""Keep the human-readable admin inventory aligned with callable model tools."""
import json
from pathlib import Path

from ai_agent.schemas import tools_schema
from ai_agent.tools import ResearchTools


def test_admin_inventory_matches_callable_tools():
    catalog = json.loads((Path(__file__).resolve().parents[2] / 'shared' / 'agentToolCatalog.json').read_text(encoding='utf-8'))
    entries = [tool for group in catalog['groups'] for tool in group['tools']]
    names = [tool['name'] for tool in entries]
    assert len(names) == len(set(names))
    assert set(names) == {tool['name'] for tool in tools_schema()}
    for tool in entries:
        assert callable(getattr(ResearchTools, tool['name']))
        assert all(tool[field].strip() for field in ('title', 'source', 'description', 'requirement', 'example'))
