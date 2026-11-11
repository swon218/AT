"""Real SQLite continuation at operating universe size, with controlled chunk/time.

Synthetic candles and virtual clock exercise >4 calls and >60 seconds without
depending on test-machine throughput or touching the operating DB.
"""
from dataclasses import replace
import sqlite3
import pytest
from lab.store import connect, SOURCE, QUALITY_POLICY
from ai_agent.config import Settings
from ai_agent.market import expected_sessions
from ai_agent.screener import RsiScreener
from ai_agent.screen_engine import ScreenEngine
from ai_agent import screen_engine
from deploy.screener_gate import run_case
from .fixtures import NOW, make_lab
from .test_stock_screen import query


class Clock:
    value=0
    def __call__(self):return self.value


@pytest.fixture
def large_db(tmp_path):
    path=tmp_path/'2719.sqlite'
    db=connect(path)
    days=expected_sessions('2026-09-01','2026-10-27')[-30:]
    db.execute('CREATE TEMP TABLE days(day TEXT,i INTEGER)')
    db.executemany('INSERT INTO days VALUES(?,?)',[(day,i) for i,day in enumerate(days)])
    db.executemany('INSERT INTO symbols(code,name,market,source) VALUES(?,?,?,?)',[(f'{i:06}',f'Fixture {i}','KOSPI',SOURCE) for i in range(2719)])
    db.execute('INSERT INTO candles SELECT code,day,1000-i,1005-i,995-i,1000-i,100,1 FROM symbols CROSS JOIN days')
    db.execute("INSERT INTO raw_candles SELECT code,date,?,'fixture','{}',date,date FROM candles",(SOURCE,))
    db.execute("INSERT INTO candle_quality_versions SELECT code,date,?,'fixture',?,'original','',0,high,low,date FROM candles",(SOURCE,QUALITY_POLICY))
    db.execute("INSERT INTO candle_quality SELECT code,date,?,'fixture',? FROM candles",(SOURCE,QUALITY_POLICY))
    db.commit();db.close()
    return path


@pytest.mark.parametrize('first_chunk',[1088,384])
def test_2719_real_sqlite_requires_more_than_four_calls_and_keeps_completed_cache(large_db,monkeypatch,first_chunk):
    clock=Clock()
    class ChunkScanner(RsiScreener):
        def _scan(self,db,market,cutoff,max_symbols,deadline,previous=None,**kw):
            before=previous['scanned'] if previous else 0
            chunk=384 if before else first_chunk
            result=super()._scan(db,market,cutoff,min(max_symbols,before+chunk),deadline,previous,**kw)
            clock.value+=11
            return result
    monkeypatch.setattr(screen_engine,'RsiScreener',lambda **kw:ChunkScanner(clock=clock,**kw))
    engine=ScreenEngine();records=[]
    try:
        result=run_case(engine,Settings(lab_path=str(large_db)),query(),NOW,'large',clock=clock,emit=records.append)
        scans=[r for r in records if r['phase']!='cache']
        assert len(scans)==(6 if first_chunk==1088 else 8)
        assert scans[3]['scanned']==(2240 if first_chunk==1088 else 1536)
        assert scans[-1]['scanned']==2719 and scans[-1]['valid']==2719
        assert scans[-1]['not_scanned']==0 and records[-1]['cache_hit']
        assert len({(r['data_version'],r['data_read_at']) for r in records})==1
        assert all(r.get('snapshot_released') for r in records)
        assert len({i['code'] for i in result['items']})==20
    finally:engine.close()


def test_partial_absolute_expiry_and_completed_ttl_are_independent(tmp_path):
    path=tmp_path/'ttl.sqlite';make_lab(path)
    clock=Clock()
    class One(RsiScreener):
        def _scan(self,db,market,cutoff,max_symbols,deadline,previous=None):
            before=previous['scanned'] if previous else 0
            return super()._scan(db,market,cutoff,min(max_symbols,before+1),deadline,previous)
    scanner=One(clock=clock);settings=Settings(lab_path=str(path))
    try:
        first=scanner.scan(settings,'ALL','2026-10-27')
        clock.value=100
        assert scanner.scan(settings,'ALL','2026-10-27')['scanned']==2
        clock.value=301  # absolute first-read deadline, not renewed at t=100
        restarted=scanner.scan(settings,'ALL','2026-10-27')
        assert restarted['scanned']==1 and restarted['resumed']==0
        assert restarted['data_read_at']!=first['data_read_at']
        clock.value=400;assert scanner.scan(settings,'ALL','2026-10-27')['scanned']==2
        clock.value=450;assert scanner.scan(settings,'ALL','2026-10-27')['scanned']==3
        clock.value=509;assert scanner.scan(settings,'ALL','2026-10-27')['cache_hit']
        clock.value=510;assert scanner.scan(settings,'ALL','2026-10-27')['scanned']==1
        with sqlite3.connect(path) as db:db.execute("UPDATE symbols SET active=0 WHERE code='005930'")
        changed=scanner.scan(settings,'ALL','2026-10-27')
        assert changed['data_version']!=restarted['data_version'] and changed['resumed']==0
    finally:scanner.close()


class FakeEngine:
    scanners={}
    def __init__(self,clock,progress=(1,2),mutate=None,seconds=1):
        self.clock,self.progress,self.mutate,self.seconds=clock,iter(progress),mutate,seconds
    def execute(self,settings,q,now):
        count=next(self.progress,2);self.clock.value+=self.seconds
        result={'snapshot_id':'a','items':[], 'coverage':{'universe':2,'scanned':count,'not_scanned':2-count,'valid':count,'excluded':{},'data_version':'a','data_read_at':'first','cache_hit':q.snapshot_id is not None and count==2}}
        if self.mutate:self.mutate(result)
        return result


@pytest.mark.parametrize('kind,expected',[
    ('stall','gate_no_progress'),('snapshot','gate_snapshot_or_progress_expired'),
    ('expired','gate_snapshot_or_progress_expired'),('partial_cache','gate_partial_cache_hit'),
    ('call_timeout','gate_call_time_or_snapshot_limit'),('total_timeout','gate_total_time_limit'),
    ('max_calls','gate_call_limit_incomplete'),('cache','gate_cache_mismatch'),
])
def test_gate_still_rejects_incomplete_changed_stalled_or_over_budget_work(kind,expected):
    clock=Clock();seen=[]
    def mutate(r):
        seen.append(r)
        if kind=='snapshot' and len(seen)>1:r['snapshot_id']='b'
        if kind=='expired' and len(seen)>1:r['coverage']['data_read_at']='new'
        if kind=='partial_cache':r['coverage']['cache_hit']=True
        if kind=='cache' and len(seen)>2:r['items']=[{'different':True}]
    progress=(1,1) if kind in ('stall','snapshot','expired','max_calls','partial_cache','total_timeout') else (1,2)
    engine=FakeEngine(clock,progress,mutate,13 if kind=='call_timeout' else 1)
    with pytest.raises(AssertionError,match=expected):
        run_case(engine,Settings(),query(),NOW,kind,clock=clock,emit=lambda _:None,
                 max_calls=1 if kind=='max_calls' else 64,max_seconds=12 if kind=='total_timeout' else 180)
