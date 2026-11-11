"""Server-owned execution identity. No provider call or credentials in the output."""
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import subprocess
from .roles import ARCHITECTURE, ORCHESTRATOR, DELEGATE, SPECIALISTS, MAX_PARALLEL, MAX_WAVES
from .schemas import tools_schema

def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,default=str).encode()).hexdigest()

@lru_cache(maxsize=1)
def identity():
    root=Path(__file__).resolve().parents[1]
    try:
        git=['git','-c',f'safe.directory={root}']
        sha=subprocess.run([*git,'rev-parse','HEAD'],cwd=root,capture_output=True,text=True,timeout=3,check=True).stdout.strip()
        dirty=bool(subprocess.run([*git,'status','--porcelain','--untracked-files=no'],cwd=root,capture_output=True,text=True,timeout=3,check=True).stdout)
    except (OSError,subprocess.SubprocessError):
        sha,dirty=None,None
    return {'code_sha':sha,'dirty':dirty,'architecture':ARCHITECTURE,
            'prompt_hash':digest({'orchestrator':ORCHESTRATOR,**{name:role.instructions for name,role in SPECIALISTS.items()}}),
            'schema_hash':digest([DELEGATE,tools_schema()]),
            'role_manifest':{name:list(role.tools) for name,role in SPECIALISTS.items()},
            'graph_limits':{'parallel':MAX_PARALLEL,'batches':MAX_WAVES}}

def runtime_metadata(settings):
    return {**identity(),'model':settings.model,'data_mode':'production',
            'limits':{name:getattr(settings,name) for name in ('rounds','tool_calls','external_requests','tokens','seconds','max_usd','tool_seconds')}}
