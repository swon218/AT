"""Reviewed seed cases. Expected ATR/RSI are independently hand-derived.

Each synthetic bar has high-low=10 and changes close by one. Therefore TR=10,
ATR14=10. A strictly falling series has Wilder RSI14=0; rising has RSI14=100.
These are assertions, never calculated by the implementation under evaluation.
"""
import json
from pathlib import Path


def cases():
    groups = [
        ('개념 설명', [
            ('RSI 개념', 'RSI가 뭐야?', 'base', [{'type':'no_tools'}]),
            ('추세 강도', 'ADX가 높으면 주가가 오른다는 뜻이야?', 'base', [{'type':'no_tools'}]),
            ('거래량 지표 비교', 'OBV와 MFI는 무엇이 달라?', 'base', [{'type':'no_tools'}]),
            ('변동성 해석', 'ATR을 종목 간에 비교할 때 주의할 점은?', 'base', [{'type':'no_tools'}]),
        ]),
        ('지표 조회·조건검색', [
            ('ATR 검산', '삼성전자 확정 일봉 ATR 14 값을 알려줘.', 'base', [{'type':'tool','name':'get_stock_indicators'},{'type':'numeric','name':'atr','value':10}]),
            ('RSI 검산', '삼성전자 확정 일봉 RSI 14를 알려줘.', 'base', [{'type':'numeric','name':'rsi','value':0}]),
            ('복수 지표', '네이버 MFI와 CCI를 확정 일봉으로 알려줘.', 'base', [{'type':'tool','name':'get_stock_indicators'}]),
            ('RSI 조건', '코스피 RSI 14가 30 이하인 종목을 찾아줘.', 'base', [{'type':'tool','name':'screen_stocks'}]),
            ('복합 조건', 'RSI 14가 30 이하이고 종가가 SMA 20 아래인 종목 찾아줘.', 'base', [{'type':'tool','name':'screen_stocks'}]),
            ('추세 전환', '슈퍼트렌드 ATR 10 배수 3이 상승 전환한 종목을 찾아줘.', 'base', [{'type':'tool','name':'screen_stocks'},{'type':'empty'}]),
        ]),
        ('뉴스·복합 조사', [
            ('밤사이 뉴스', '삼성전자 밤사이 뉴스를 근거와 함께 설명해줘.', 'base', [{'type':'tool','name':'get_stock_news'}]),
            ('뉴스 키워드', '네이버 최근 7일 AI 뉴스를 정리해줘.', 'base', [{'type':'tool','name':'get_stock_news'}]),
            ('뉴스 상세 한계', '삼성전자 오늘 뉴스의 기사 전문을 읽고 알려줘.', 'base', []),
            ('조건과 뉴스', '코스피 RSI 14가 30 이하인 종목을 찾고 그중 한 종목의 밤사이 뉴스를 확인해줘.', 'base', [{'type':'tool','name':'screen_stocks'},{'type':'tool','name':'get_stock_news'}]),
        ]),
        ('알림 초안·사용자 확인', [
            ('등록 종목 초안', '네이버 20만원 도달 시 한 번 알림 받고 싶어.', 'watched', [{'type':'action','value':'draft'},{'type':'rule','name':'threshold','value':200000}]),
            ('미등록 종목', '삼성전기 100만원일 때 알림 받고 싶어.', 'base', [{'type':'action','value':'watchlist_confirmation'},{'type':'rule','name':'threshold','value':1000000}]),
            ('관심종목 가득 참', '네이버 20만원일 때 알려줘.', 'full', [{'type':'action','value':'watchlist_confirmation'}]),
            ('추가 승인', '네이버 20만원 도달 알림 초안을 만들어줘.', 'approve', [{'type':'action','value':'watchlist_confirmation'}]),
            ('추가 거절', '삼성전기 100만원 도달 알림을 받고 싶어.', 'decline', [{'type':'action','value':'watchlist_confirmation'}]),
            ('여러 저장 조건', '네이버 저장 알림의 가격을 21만원으로 바꿔줘.', 'multiple', []),
            ('반복과 만료 수정', '방금 네이버 초안을 21만원, 11월 5일까지 반복으로 바꿔줘.', 'draft', [{'type':'action','value':'draft'},{'type':'rule','name':'frequency','value':'repeat'},{'type':'rule','name':'expires_on','value':'2026-11-05'}]),
            ('미지원 지표 알림', '삼성전자 RSI가 30 아래로 내려가면 카톡 보내줘.', 'watched', []),
        ]),
        ('모호함·후속 대화', [
            ('종목명 모호', '삼성 알림을 설정해줘.', 'base', []),
            ('가격 누락', '네이버 가격 알림을 설정해줘.', 'watched', []),
            ('앞선 종목 기억', '그 종목의 ATR 14도 알려줘.', 'base', [{'type':'tool','name':'get_stock_indicators'}]),
            ('비회원 알림', '네이버 20만원일 때 알림 받고 싶어.', 'guest', [{'type':'action','value':'unavailable'}]),
        ]),
        ('미지원·빈 결과·장애', [
            ('DART 미지원', 'DART에서 삼성전자 최근 5년 재무제표를 직접 조회해줘.', 'base', []),
            ('뉴스 빈 결과', '삼성전자 오늘 뉴스 알려줘.', 'news_empty', [{'type':'empty'}]),
            ('뉴스 조회 장애', '삼성전자 오늘 뉴스 알려줘.', 'news_error', [{'type':'error','value':'news_provider_error'}]),
            ('일봉 DB 장애', '삼성전자 ATR 14 알려줘.', 'db_error', [{'type':'error','value':'lab_data_not_ready'}]),
        ]),
    ]
    result=[]
    held={3,9,12,19,25,29}
    for category, rows in groups:
        for title, question, scenario, checks in rows:
            n=len(result)
            result.append({'id':f'00000000-0000-4000-8000-{n+1:012d}', 'spec':{
                'title':title,'category':category,'question':question,
                'context':[{'role':'user','content':'앞으로 삼성전자에 관해 질문할게.'},{'role':'assistant','content':'삼성전자에 관한 질문을 이어가 주세요.'}] if n==24 else [],
                'dataset':'atlas-fixed-v1','scenario':scenario,'split':'holdout' if n in held else 'dev','status':'active',
                'success':'요청한 종목·조건을 유지하고 도구 근거와 기준일을 설명한다. 미지원·모호한 요청은 정확히 안내한다.',
                'failure':'허위 수치·출처·실행 완료 안내, 승인 없는 변경, 무관한 조건 대체, 끝없는 도구 호출.',
                'rubric':'질문의 모든 요구를 충족했는지 검토한다. 자동 검사는 일부 구조만 확인하므로 설명의 사실성·충분성은 직접 평가한다.',
                'checks':checks+[{'type':'no_mutation'}]}})
    return result


def all_cases():
    return cases() + json.loads((Path(__file__).parents[2] / 'shared/marketEvalCases.json').read_text(encoding='utf-8'))


if __name__ == '__main__':
    Path('shared/evalCases.json').write_text(json.dumps(cases(),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
