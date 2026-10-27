# 구현 검증 기록 · 2026-10-28

실제 운영 키/개인 계정/주문/유료 모델/운영 DB를 사용하지 않았다. 기존 파일은 작업 시작 시 main/clean 상태였고 origin은 https://github.com/swon218/AT.git이었다. 운영 반영은 이 문서의 존재로 확인되지 않는다.

## 통과

- 기존 서버·자산·전략·검색·비밀번호 복구·기존 에이전트 로컬 기록 테스트를 포함한 Node 테스트 113개.
- Python 에이전트 테스트 22개. 실제 실행 루프/Pydantic/공식 SDK HTTP mock/실제 읽기 전용 SQLite 도구를 통과한다. fixture 결과가 달라지면 다음 모델 턴의 뉴스 페이지 선택과 답변 내용이 달라짐을 검증했다. 복합 질문에서는 실제 RSI 결과에 있던 코드만 후속 뉴스 인자가 된다.
- 실제 localhost HTTP 통합 테스트 1개. Node → 내부 FastAPI → 테스트 모델의 실제 function_call/call_id → SQLite/Naver transport fixture → 도구 결과를 다음 모델 입력에 전달 → SQL 예약·단계·대화 저장 → API 재조회. 복합 질문에서 모델 4왕복/뉴스 2종목, 누적 토큰 100 input/80 output/16 reasoning을 확인했다. reasoning은 output 포함이며 이중 합산하지 않는다. 중복 전송 뒤 request 1개, 다른 사용자 접근 404를 확인했다.
- SQL 신규 설치/재실행/의도한 schema drift 실패, RLS/직접 접근/RPC 권한, FK/UNIQUE/CHECK, guest 1·2회/3회 거부, 실패 복구, 삭제 후 사용량 유지, 로그인 3회 이상, 경쟁 예약, KST 날짜별 원장, 메시지 cursor, lease 만료 후 unknown, 기존 확인 토큰 보존, late completion 취소를 PGlite에서 실행했다. migration과 SQL Editor 파일은 byte 동일함을 자동 검사한다.
- API 키 없이 ASGI 정상 기동, 내부 인증 필요, 키 미설정 503, Node에서 미차감, production fixture 차단, AI 환경으로 broker 키 유입 차단.
- known Wilder RSI 예제 70.464135, 보합 50, 하락만 0. 기존 chart RSI와 같은 초기화/평활 공식. 휴장일/주말/장 시작 전 기간, 누락/오래된/품질 기록과 읽기 전용을 확인했다.
- 출처 ID 조작, 원문 불일치, 수치 조작, 무관 주장, 증가/감소 반전, 최신 근거 누락을 검출하고 최대 보정 후 종료. 동일 호출 반복, 모델/도구/외부 요청/기사/종목/토큰/시간/비용 한도와 API 오류 unknown 처리를 검사했다.
- Vite production 빌드 성공. 기존 큰 JS bundle에 대한 경고는 남아 있다.
- 실제 in-app 브라우저에서 fixture 질문의 답변/출처 링크/실행 기록, 새로고침 복원, 제목 변경/목록, 메인·작은 창의 같은 메시지/초안 공유를 확인했다. 테스트 전용 API는 broker 경로를 거부한다.
- `tests/agentScope.html`에서 실제 hook에만 test API를 주입해 A→B 응답 대기 중 A 기록/초안 즉시 제거, 로그아웃 뒤 늦은 B 응답 무시, A 복귀 시 A 초안만 복원을 확인했다. 실제 Supabase 로그인 테스트가 아니다.

## 재현

```powershell
npm ci
npm run test:server
npm run test:agent
npm run test:agent:integration
.venv-ai/Scripts/python.exe -m pytest ai_agent/tests -q
npm run build
```

Windows는 별도 `.venv-ai`에 `ai_agent/requirements-test.lock`을 설치한다. Linux에서는 `.venv-ai/bin/python`을 사용하며 HTTP 통합 테스트에 `AI_TEST_PYTHON`을 그 경로로 설정한다. Python 3.10 이상. 이 작업 환경의 샌드박스에서 Windows asyncio가 정지해, fixture Python/HTTP 테스트만 정상 로컬 네트워크 실행 권한으로 검사했다. 유료/외부 실서비스 호출은 없었다.

수동 UI 재현: `node tests/agentBrowserHarness.js`를 실행하고, 별도 shell에서 `ATLAS_DEV_API_TARGET=http://127.0.0.1:13000`, 빈 `VITE_SUPABASE_URL`, 빈 `VITE_SUPABASE_PUBLISHABLE_KEY`, 빈 `VITE_API_BASE_URL`로 `npm run dev -- --port 15173 --strictPort`를 실행한다. http://127.0.0.1:15173 및 `/tests/agentScope.html`에서 확인한다. 이 진입점들은 테스트 전용이며 production 서비스에는 쓰지 않는다.

## 별도 운영 검증 필요

- OpenAI 결제/키/모델 권한, 실제 모델이 도구를 고르는 판단 품질·기사 관련성·의미 부합·감성 분류는 키 부재로 미검증이다. 결정적 인용/수치/반전 검사는 완전한 의미 검증이 아니다. fixture 통과는 실모델 성능 증거가 아니다.
- 실제 Naver legacy/HUB 키, 운영 신청/이관 상태와 실제 검색 결과는 확인하지 않았다.
- 운영 SQLite의 최신성/수집 종목 범위/파일·WAL 권한과 임시 휴장 등 운영 달력 변경은 확인하지 않았다.
- SQL은 PostgreSQL 기반 PGlite에서 검증했다. 실제 운영 Supabase schema/PostgREST/RLS service role 통합과 별도 PostgreSQL 다중 connection의 잠금 경합은 미검증이다. Promise 경쟁은 PGlite 단일 DB 엔진에서 실행했다. SQL 적용은 사용자의 SQL Editor 작업으로 남겨 두었다.
- 실제 도메인/Vercel 프록시/production Secure 쿠키/CORS·proxy header/실제 Supabase 계정 전환/타기기 복원은 미검증이다. local fixture 계정 전환을 실제 계정 인증 검증으로 표현하지 않는다.
- Linux systemd 설치, 권한·프로세스 격리, 운영 재시작/응답 유실, backup/rollback, VPS/Vercel 배포는 수행하지 않았다. 해당 단계는 `AI_AGENT_VPS_HERMES.md`에 전달한다.

Git 커밋/원격 push 결과와 최종 배포 대상 해시는 최종 사용자 답변에서 별도로 보고한다. 실제 운영 SQL/VPS 배포는 이 요청에서 직접 수행하지 않는다.
