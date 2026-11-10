# AI 품질평가 도구 정리

이번 변경은 관리자 프런트 화면의 사용가능 도구 카탈로그, 운영 확인 기록, 스키마 일치 검사다. 분석 AI·API·평가 worker의 실행 코드는 변경하지 않는다.

- Supabase: 추가 SQL 없음.
- Vercel: main 자동 배포로 반영. 추가 환경변수 없음.
- VPS: 기능 반영을 위한 설치·환경변수·서비스 재시작 불필요. 저장소를 동기화하는 경우 운영 작업 트리와 현재 SHA를 확인하고 통상 절차를 따른다. 일봉 수집·알림 worker·DART 타이머는 건드리지 않는다.
- 화면의 운영 기록은 2026-11-11 05:23:01 KST에 운영자가 전달한 헤르메스 점검을 표시한다. 자동 health 모니터가 아니며 최신 수신 성공으로 해석하지 않는다.
- 신규 도구 추가·삭제 시 shared/agentToolCatalog.json을 갱신하고 python -m pytest ai_agent/tests/test_tool_catalog.py로 실제 tools_schema()와 일치하는지 확인한다.
- 실시간 시세·DART를 분석 AI에 연결하는 작업은 이번 변경에 포함되지 않는다.
