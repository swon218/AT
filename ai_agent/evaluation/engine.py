"""Production graph with isolated data; no account, alert worker, or broker writes."""
import asyncio
from dataclasses import replace
from datetime import datetime
from email.utils import format_datetime
import hashlib
import inspect
import json
from pathlib import Path
import tempfile
import time
from uuid import uuid4
import httpx
from lab.store import connect, save_rows
from ai_agent.config import Settings
from ai_agent.market import expected_sessions
from ai_agent.provider import OpenAIProvider, Turn
from ai_agent.graph import ResearchGraph
from ai_agent.roles import ARCHITECTURE, DELEGATE, ORCHESTRATOR, SPECIALISTS, MAX_PARALLEL, MAX_WAVES
from ai_agent.schemas import tools_schema
from ai_agent.screen_engine import ScreenEngine
from ai_agent.screener import RsiScreener
from ai_agent.tools import ResearchTools, NewsSource

NOW=datetime.fromisoformat('2026-10-28T08:00:00+09:00')
DATASET='atlas-fixed-v1'
STOCKS=[('005930','삼성전자',-1),('000660','SK하이닉스',-1),('035420','NAVER',1),('009150','삼성전기',1)]


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,default=str).encode()).hexdigest()


def metadata(settings):
    # Hash actual files, not merely the web build SHA. No shell or user path input.
    root=Path(__file__).resolve().parents[2]
    files=sorted((root/'ai_agent').rglob('*.py'))+sorted((root/'lab').glob('*.py'))
    code=digest([(str(p.relative_to(root)),hashlib.sha256(p.read_bytes()).hexdigest()) for p in files])
    import subprocess
    try:
        sha=subprocess.run(['git','rev-parse','HEAD'],cwd=root,capture_output=True,text=True,timeout=3,check=True).stdout.strip()
        dirty=bool(subprocess.run(['git','status','--porcelain','--untracked-files=no'],cwd=root,capture_output=True,text=True,timeout=3,check=True).stdout)
    except (OSError,subprocess.SubprocessError): sha,dirty=None,None
    from importlib.metadata import version
    return {'code_sha':sha,'dirty':dirty,'code_hash':code,
            'architecture':ARCHITECTURE,'framework_version':version('langgraph'),
            'prompt_hash':digest({'orchestrator':ORCHESTRATOR,**{name:role.instructions for name,role in SPECIALISTS.items()}}),
            'schema_hash':digest([DELEGATE,tools_schema()]),
            'role_manifest':{name:list(role.tools) for name,role in SPECIALISTS.items()},
            'graph_limits':{'parallel':MAX_PARALLEL,'batches':MAX_WAVES},
            'dataset':DATASET,'data_hash':digest({'stocks':STOCKS,'now':NOW,'generator':inspect.getsource(make_data),'news':inspect.getsource(transport_for),'state':inspect.getsource(state_for)}),
            'now':NOW.isoformat(),'model':settings.model,'settings':{k:getattr(settings,k) for k in ('rounds','tool_calls','tokens','seconds','max_usd','output_tokens','input_usd_per_million','output_usd_per_million')}}


def make_data(path):
    db=connect(path)
    days=expected_sessions('2025-10-01','2026-10-27')
    for code,name,direction in STOCKS:
        rows=[{'date':day,'open':1000+direction*n,'close':1000+direction*n,'high':1005+direction*n,'low':995+direction*n,'volume':100} for n,day in enumerate(days)]
        save_rows(db,code,name,'KOSPI',rows,days[0],days[-1],full=True)
    db.close()


def state_for(scenario):
    stock={'code':'035420','name':'NAVER','market':'KOSPI'}
    if scenario=='guest': return None
    watched=[stock] if scenario in ('watched','multiple','draft') else []
    if scenario=='full': watched=[{'code':f'{700000+i:06}','name':f'평가종목{i}','market':'KOSPI'} for i in range(20)]
    rules=[{'rule_id':f'10000000-0000-4000-8000-{i:012d}','version':str(uuid4()),'code':'035420','kind':'price_touch','threshold':200000+i*10000,'frequency':'once','expires_on':'2026-11-04','status':'active'} for i in range(2)] if scenario=='multiple' else []
    draft={'id':str(uuid4()),'code':'035420','kind':'price_touch','threshold':200000,'frequency':'once','expires_on':'2026-11-04'} if scenario=='draft' else None
    return {'watchlist':watched,'rules':rules,'draft':draft}


def transport_for(scenario):
    def respond(request):
        if scenario=='news_error': return httpx.Response(503)
        if scenario=='news_empty': return httpx.Response(200,json={'total':0,'items':[]})
        name=request.url.params['query'].split()[0]
        item={'title':f'{name} 연구개발 계획 발표','description':f'{name} 연구개발 계획 발표. 향후 성과는 확인되지 않았습니다.',
              'originallink':'https://example.invalid/evaluation/news','pubDate':format_datetime(NOW.replace(hour=6))}
        return httpx.Response(200,json={'total':1,'items':[item]})
    return httpx.MockTransport(respond)


class RecordedTools(ResearchTools):
    async def execute(self,name,args):
        result=await super().execute(name,args)
        self.outputs.append({'agent':getattr(self,'agent','unassigned'),'name':name,'arguments':json.loads(args),'result':result})
        return result


class ContractProvider:
    """Deterministic plumbing probe. Explicitly NOT a model-quality evaluation."""
    async def respond(self,items,instructions,tools,output_limit):
        usage={'input_tokens':0,'output_tokens':0,'reasoning_tokens':0,'cached_tokens':0}
        if any(tool['name']=='delegate_research' for tool in tools) and not any(item.get('type')=='function_call_output' for item in items):
            task={'agent':'technical','goal':'고정된 평가 시각과 달력 확인','symbols':[], 'period':None,'constraints':'공개 달력만 확인','deliverable':'시각과 조회 범위'}
            return Turn([{'type':'function_call','call_id':str(uuid4()),'name':'delegate_research','arguments':json.dumps({'tasks':[task]})}],'',usage)
        if not any(item.get('type')=='function_call_output' for item in items):
            return Turn([{'type':'function_call','call_id':str(uuid4()),'name':'get_market_context','arguments':'{}'}],'',usage)
        text=json.dumps({'kind':'concept','summary':'평가 실행 경로를 확인했습니다. 질문 이해 품질 검증은 실제 모델 평가가 필요합니다.','sentiment':'자료 부족','claims':[],'uncertainty':['코드 검증용 모의 응답입니다.']},ensure_ascii=False)
        return Turn([],text,usage)


def grade(spec,result,outputs,mode):
    checks=[]
    def add(name,ok,critical=False): checks.append({'name':name,'status':'pass' if ok else 'fail','critical':critical})
    if mode=='code':
        add('운영 LangGraph·전문 담당·고정 시각 도구 실행',result['status']=='completed' and any(o['name']=='get_market_context' for o in outputs) and result.get('architecture')==ARCHITECTURE)
        checks.append({'name':'질문 이해·도구 선택·답변 품질','status':'na','critical':False})
        return checks,'review'
    action=result.get('alert_action') or {}
    for check in spec['checks']:
        kind=check['type']; value=check.get('value'); name=check.get('name')
        if kind=='tool': add('도구 조회: '+str(name),any(o['name']==name for o in outputs))
        elif kind=='no_tools': add('불필요한 도구 조회 없음',not outputs)
        elif kind=='action': add('알림 결과: '+str(value),action.get('kind')==value)
        elif kind=='rule': add('알림 조건: '+str(name),action.get('rule',{}).get(name)==value)
        elif kind=='kind': add('답변 유형: '+str(value),result.get('answer',{}).get('kind')==value)
        elif kind=='numeric':
            rows=[r for o in outputs for r in o['result'].get('items',[]) if isinstance(r,dict)]
            add('독립 검산: '+str(name),any((r.get('metric',{}).get('name') if isinstance(r.get('metric'),dict) else r.get('name'))==name and isinstance(r.get('value'),(int,float)) and abs(r['value']-value)<1e-7 for r in rows))
        elif kind=='empty': add('정상 빈 결과 확보',any(o['result'].get('status')=='empty' or (o['result'].get('status') in ('success','partial') and o['result'].get('coverage') and not o['result'].get('items')) for o in outputs))
        elif kind=='error': add('예상 장애 전달',any(o['result'].get('code')==value for o in outputs))
        elif kind=='no_mutation': add('운영 쓰기 도구 없음',all(o['name'] in {t['name'] for t in tools_schema()} for o in outputs),True)
    expected_error=any(c['type']=='error' for c in spec['checks'])
    if not expected_error: add('실행 완료',result['status'] in ('completed','partial') and not result.get('error_code'))
    checks.append({'name':'설명 사실성·충분성·허위 완료 안내 직접 검토','status':'review','critical':False})
    # Do not pass natural-language semantics based on substring matching.
    return checks,'fail' if any(c['status']=='fail' for c in checks) else 'review'


async def evaluate(job,settings,provider=None):
    spec=job['specimen']['spec']; mode=job['mode']; started=time.monotonic()
    if spec['dataset']!=DATASET: raise ValueError('unapproved_dataset')
    with tempfile.TemporaryDirectory(prefix='atlas-eval-') as folder:
        path=Path(folder)/'lab.sqlite'
        if spec['scenario']!='db_error': make_data(path)
        s=replace(settings,lab_path=str(path),naver_id='fixed',naver_secret='fixed',naver_mode='legacy',max_usd=min(0.25,job.get('allowance') or 0.25))
        news=NewsSource(s,transport=transport_for(spec['scenario']))
        context=state_for(spec['scenario'])
        tools=RecordedTools(s,news=news,now=NOW,context=spec['context'],alert_context=context,
                            screener=RsiScreener(),screen_engine=ScreenEngine())
        tools.outputs=[]
        p=provider or (ContractProvider() if mode=='code' else OpenAIProvider(s))
        try: result=await ResearchGraph(s,p,tools).run(spec['question'],spec['context'])
        finally:
            if isinstance(p,OpenAIProvider) and p.client: await p.client.close()
            tools.screener.close()
            tools.screen_engine.close()
        checks,grade_value=grade(spec,result,tools.outputs,mode)
        fingerprint=digest({'spec':spec,'metadata':{k:v for k,v in job.get('metadata',{}).items() if k not in ('code_sha','code_hash','dirty','prompt_hash','schema_hash','architecture','framework_version','role_manifest','graph_limits')},'mode':mode})
        result.update(checks=checks,grade=grade_value,fingerprint=fingerprint,elapsed_ms=round((time.monotonic()-started)*1000),tool_outputs=tools.outputs,
                      web_verification='not_run',scenario=spec['scenario'])
        if mode=='code':
            result['usage'].update(provider='fixture',paid_model_calls=0)
        # Node builds the same server-authored alert card using an in-memory store.
        result['eval_state']=context
        if len(json.dumps(result,ensure_ascii=False).encode())>185000:
            result['tool_outputs']=[{'name':o['name'],'arguments':o['arguments'],'result':{k:o['result'].get(k) for k in ('status','code','coverage','as_of')}} for o in tools.outputs]
            result['trace_truncated']=True
        if len(json.dumps(result,ensure_ascii=False).encode())>185000:
            result['steps']=result.get('steps',[])[-20:]
            result['answer']['result_sets']=[]
            result['trace_truncated']=True
        return result
