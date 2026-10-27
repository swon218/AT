# 구현 검증 기록 · 2026-10-28

실제 운영 키/개인 계정/주문/유료 모델/운영 DB를 사용하지 않았다. 기존 파일은 작업 시작 시 main/clean 상태였고 origin은 https://github.com/swon218/AT.git이었다. 운영 반영은 이 문서의 존재로 확인되지 않는다.

## 통과

- 기존 서버·자산·전략·검색·비밀번호 복구·기존 에이전트 로컬 기록 테스트와 후속 프록시 테스트를 포함한 Node 테스트 115개.
- Python 에이전트 테스트 33개. 최초 22개에서 후속 달력/배치 검색 및 읽기 연결 수명 회귀 검증을 추가했다. 실제 실행 루프/Pydantic/공식 SDK HTTP mock/실제 읽기 전용 SQLite 도구를 통과한다. fixture 결과가 달라지면 다음 모델 턴의 뉴스 페이지 선택과 답변 내용이 달라짐을 검증했다. 복합 질문에서는 실제 RSI 결과에 있던 코드만 후속 뉴스 인자가 된다.
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
node --test tests/agentProxy.test.js
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

## 2026-10-28 후속 결함 수정

- 정적 Vercel 함수와 명시적 rewrite를 검사하고 실제 프록시 handler→Fastify→PGlite 통합으로 방 생성/이름 변경/메시지 복원/키 없는 요청/삭제를 확인했다. 본문 없는 DELETE의 JSON Content-Type 오류도 회귀 검사한다. 이 테스트는 실제 Vercel 라우터의 증거와 구분한다.
- 두 공시된 휴장일을 중앙 달력에 반영하고 전후 거래일 이동과 RSI 누락 검사를 확인했다. 실제 거래일 누락, 원자료/품질 누락, 격리 일봉이 candles에 없는 경우, 최대 2,000봉 및 원래 Wilder 값, 반올림 전 임계값 판정은 유지한다.
- 같은 connection의 WAL commit 감지, DB 갱신 시 전체/부분 캐시 폐기, TTL, 종목 제한, 부분 상태 재개와 정확한 미검색 표시, 읽기 전용 및 deadline을 검사한다.
- 합성 성능은 `python -m ai_agent.tests.benchmark_rsi --symbols 2715 --bars 1250 --profile-queries`로 재현한다. cold 검색이 partial이면 그대로 보고하며 다음 검색은 변경되지 않은 DB 버전의 진행 상태만 이어받는다. 운영 VPS/실제 SQLite의 속도는 별도 실측해야 한다.
- Windows/Python 3.10/SQLite 3.35.5, 실제 lab 스키마의 합성 2,715종목·최대 1,250봉·990.6MiB 임시 DB: cold 11.1058초/1,472종목(부분 결과), 재개 10.3837초/누적 2,715종목, 전체 캐시 0.0008초. 전체 분류는 valid 2,665/quarantined 45/warmup 5/missing_sessions 0이었다. 첫 검색 한 번의 전체 완료는 달성하지 못했다. 각 검색은 기존 12초 도구 한도 내였으며 두 회의 누적 실측이다. 임시 DB 생성 42.05초는 서비스 조회 시간이 아니다. 같은 분석 안의 페이지들은 검사 범위·정렬을 고정하고 새 분석에서만 부분 진행을 이어받는다.
- 후속 운영 절차는 `AI_AGENT_FOLLOWUP_HERMES.md`에 있다. Supabase SQL 변경은 없다. 기존 45종목 품질 격리나 수집 exit 1 정책을 변경하지 않는다.

## 운영 롤백 보고 이후 SQLite 연결 수정

- 헤르메스 보고: 운영 SQLite 3.37.2/약 2.29GB DB에서 두 번째 읽기 전용 연결의 종료만으로 기존 감시 연결의 data_version이 바뀌어 첫 검색이 ScanChanged로 실패했다. 해당 운영 코드는 d794a42로 롤백됐다. 이는 운영자 보고이며 로컬에서 운영 DB를 직접 열어 재현한 결과가 아니다.
- 검색과 data_version 확인에 DB당 하나의 persistent 읽기 전용 연결을 사용한다. BEGIN 후 실제 schema 읽기로 snapshot을 고정하고 버전을 확인한다. 검색·cache hit·예외 모두 progress handler를 제거하고 ROLLBACK하여 snapshot을 해제한 뒤 같은 연결에서 버전을 다시 확인한다. 버전 변화나 파일 교체 시 결과/진행 상태 폐기 정책은 유지한다.
- 보고된 read-only connection close → 감시 버전 변화 조건은 주입된 수명 주기 모델로 재현한다. 테스트는 기존의 두 연결 방식에서 버전 차이를 확인하고 새 검색은 연결 하나만 사용해 cold/cache hit에 성공하는지 검사한다. 이 모델을 실제 SQLite 자체 결함의 재현이라고 표현하지 않는다.
- 별도로 실제 WAL writer가 snapshot 유지 중 commit해도 조회 중에는 이전 이름이 유지되고, snapshot 해제 후 ScanChanged로 결과를 폐기하는지 검사한다. 다음 검색의 새 데이터와 캐시 무효화도 검사한다.
- 시스템 Python 변경 없이 SQLite 공식 3.37.2 Windows x64 DLL을 프로젝트 캐시에 격리해 전체 Python 테스트를 실행한다. 다운로드는 https://www.sqlite.org/2022/sqlite-dll-win64-x64-3370200.zip 이며 archive SHA-256은 456bef46dde6e18e66ca6183a210248286b03196a688de57f3345d7df14c808c였다. 이 테스트 런타임은 운영 배포 파일이나 Python 의존성에 추가하지 않는다.
- 기본 SQLite 3.35.5와 격리 SQLite 3.37.2에서 Python 33개씩 통과했다. SQLite 3.37.2/Windows에서 합성 raw padding 400/2,715종목/최대 1,250봉/2,640.1MiB DB는 cold 11.0063초/1,600종목, 재개 7.5199초/누적 2,715종목, 캐시 0.0006초였고 ScanChanged는 발생하지 않았다. 분류는 valid 2,665/quarantine 45/warmup 5였다. 기존 두 연결을 사용하는 native reader_probe는 이 Windows 환경에서 2→2로 안정적이었다. 즉 실제 운영 증상은 native 재현되지 않았으며, 별도 주입 모델이 그 증상의 회귀를 검사한다. 파일 크기 유사성만으로 Linux 운영 gate 통과라고 주장하지 않는다.
- Linux/VFS/운영 DB와 Windows의 차이는 남는다. 새 커밋은 운영 checkout 반영 전에 격리 worktree에서 실제 운영 SQLite를 읽기만 하는 gate를 통과해야 한다. SQL 변경, SQLite 업그레이드, 12초 한도 변경, 키 설정은 필요하지 않다.
