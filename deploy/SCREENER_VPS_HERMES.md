# 조건 검색 탭 / 공통 지표 엔진 VPS 전달문

**SQLite/WAL 후속 수정 배포는 `deploy/SCREENER_SQLITE_HERMES.md`를 먼저 읽으세요. 새 owner-side WAL guard 준비와 v2 fingerprint 지침이 이 문서의 이전 절차보다 우선합니다.**

ATLAS 저장소 `swon218/AT`의 **사용자가 전달한 `조건 검색` 커밋 전체 해시**를 대상으로 아래 작업을 진행해 주세요. 원격 main이 이동했으면 해시를 대조하고 예상과 다른 변경은 강제 반영하지 마세요. 최초 설치나 이전 SQL 재실행 요청이 아닙니다.

이번 배포는 **이 문서를 우선**합니다. 이전 `AI_AGENT_FOLLOWUP_HERMES.md`의 “Python만 재시작, Node 유지” 지침은 이전 수정에만 해당합니다. 이번 기능은 Node와 Python 모두 바뀌므로 선행 gate 통과 후 `atlas-ai.service`와 `atlas-api.service` 두 서비스의 재시작이 필요합니다.

## 변경 내용

- 실험실 → **조건 검색** → AI 에이전트 순으로 새 탭을 추가했습니다. 공통 헤더·사이드바·계정 footer는 유지합니다.
- 실험실과 같은 `LAB_DB_PATH`의 기존 일봉 OHLCV를 읽고 서버에서 지표를 계산합니다. 지표 DB/테이블·컬럼을 만들거나 수집 데이터를 변경하지 않습니다.
- 지원: OHLCV, SMA/EMA, Wilder RSI, 볼린저 하단/중심/상단(모집단 분산), 평균 거래량, MACD/시그널/히스토그램. 기간·배수, 숫자/다른 지표 비교, 이전/최근 일봉 교차, 최대 8조건 AND/OR를 지원합니다.
- 공개 수동 조회: Vercel `api/screener.js` → Node `GET/POST /api/screener` → loopback FastAPI `GET /screen/meta`, `POST /screen`. 내부 경로는 기존 `AI_INTERNAL_SECRET` 인증을 요구하며 외부 공개하지 않습니다. Node는 웹 origin·요청 수·동시성·본문 크기를 제한합니다.
- AI의 새 `screen_stocks` 도구도 같은 Python `ScreenEngine`과 검증된 조건 모델을 호출합니다. AI가 임의 SQL/코드를 실행하지 않습니다. UI에서 “AI로 이어가기”는 질문 초안만 작성합니다.
- 수동 조건검색은 OpenAI 키/LLM/대화 저장/AI 사용량 예약/증권사 API를 사용하지 않습니다. AI 자연어 실행은 이후 서버 OpenAI 키를 별도 설정해야 합니다.
- 데이터 품질 격리, 품질 version/raw 일치, 확정 거래일/누락/워밍업, OHLCV 유효성 검사와 12초 도구 한도를 유지합니다. 단일 호출 전체 완료는 보장하지 않습니다. UI는 같은 fingerprint의 진행 상태를 최대 4회 이어받고, 미검색·제외 건수를 표시합니다. 제외 종목을 임의 보정하지 않습니다.
- 이전 SQLite 3.37.2 문제에 대한 `sqlite-physical-commit-v1` 검증을 그대로 사용합니다. PRAGMA data_version 변화만으로 실제 쓰기를 판단하지 않습니다.

## 1. 운영 변경 전 격리 검증

1. 현재 운영 HEAD·서비스 상태·비공개 백업과 사용자 변경을 보존하세요. 알려진 이전 롤백 HEAD는 `d794a4231c94376bf955bdf0ebf7490268496446`이지만 **현재 상태를 실측**하세요. clean 여부와 origin 차이를 보고하고 force reset은 하지 마세요.
2. `git fetch origin main` 후 전달된 전체 해시를 격리 worktree에 checkout하세요. 기존 운영 Python 가상환경을 사용하되 실행 cwd와 실제 `ai_agent.screen_engine.__file__`이 새 worktree인지 확인하세요. worktree에 DB를 만들거나 운영 DB를 복제/이동하지 마세요.
3. `python -m pytest ai_agent/tests -q`, `node --test server/*.test.js tests/*.test.js`, `npm run build`를 실행하세요. Node 통합 테스트는 fixture Python 실행 경로를 `AI_TEST_PYTHON`으로 지정할 수 있습니다. 모든 모델은 테스트 fixture이며 실제 OpenAI 요청은 금지합니다.
4. 실제 AI 서비스 사용자와 기존 읽기 권한으로 먼저 fingerprint helper를 실행하세요: `python -I -S ai_agent/snapshot_fingerprint.py /var/lib/atlas/lab.sqlite`. 다음으로 **새 worktree 루트**에서 운영 DB를 읽기만 하는 다음 gate를 실행하세요. 서비스 사용자/DB/가상환경 경로는 실제 systemd 설정을 확인한 뒤 대입하세요. 환경파일/키는 출력하지 마세요.

```sh
# cd 는 격리 worktree 루트, python은 기존 AI venv의 절대 경로입니다.
# 명령은 실제 AI 서비스 사용자로 실행합니다.
/opt/atlas/.venv-ai/bin/python -m deploy.screener_gate --db /var/lib/atlas/lab.sqlite
```

이 명령은 모델/키를 로드하지 않고 read-only SQLite만 엽니다. RSI, 볼린저 하단 터치, RSI+20일선 복합조건을 cold → 필요 시 resume → 전체 cache까지 확인합니다. 출력은 조건별 runtime/cutoff/universe/scanned/valid/excluded/not_scanned/snapshot/cache/시간이며 데이터 행은 출력하지 않습니다. 각 snapshot이 해제되고 한 호출은 기존 12초 이내여야 합니다. `SCREENER_READONLY_GATE_PASS`만 성공입니다.

수집 실행과 commit이 겹치면 ScanChanged를 우회하지 말고 유휴 시점에 다시 확인하세요. fingerprint 검증 불가, 미검색 잔여, cache 불일치, 시간 초과는 배포 중단 사유입니다. 최신 cutoff보다 DB 일봉이 오래되면 stale_data로 제외됩니다. 이는 데이터 준비 상태 문제로 보고하고 cutoff·품질 정책을 임의로 바꾸지 마세요. PRAGMA data_version의 2→4→5 변화 자체는 실패 근거가 아닙니다. 실제 운영 WAL 쓰기 재현은 금지하며 쓰기/교체 회귀 검증은 disposable fixture DB에서만 수행하세요.

## 2. gate 통과 후 반영

1. 운영 checkout이 clean이고 기존 HEAD가 대상의 조상인지 확인한 뒤 **전달된 해시까지** fast-forward하세요. 더 최신의 미검증 origin/main을 같이 배포하지 마세요. 코드·이전 설정 복구 지점을 확보하세요.
2. 기존 `LAB_DB_PATH`, `AI_INTERNAL_URL`, 공유 `AI_INTERNAL_SECRET`을 유지하세요. `AI_PUBLIC_ORIGIN=https://at-chi-six.vercel.app` 및 Vercel `ATLAS_API_ORIGIN=https://srv1826612.tail6bd3f3.ts.net`은 기존 값을 확인하고 유지합니다. 비밀값을 웹 환경변수 `VITE_*`로 추가하지 마세요.
3. 이번 변경에 Python/Node 새 패키지·Supabase SQL 마이그레이션은 없습니다. 운영 SQLite 업그레이드, DLL 복사, SQL 재실행, 일봉 스케줄/정책 변경은 하지 마세요.
4. `atlas-ai.service` 재시작 후 내부 인증 health·loopback만 리스닝 확인, 다음 `atlas-api.service` 재시작 후 기존 Node health와 일봉 API가 정상인지 확인하세요. 기존 broker/order/asset 코드는 이번 변경에 포함하지 않았지만 Node 재시작 자체의 짧은 중단은 보고하세요. 내부 secret header는 공개 응답이나 로그에 출력하지 않습니다.
5. 운영 반영 후 같은 gate를 다시 통과시키세요. 실패하면 보존한 이전 코드로 두 서비스만 되돌리고 원인과 운영 HEAD를 보고하세요.
6. Vercel 자동 배포가 대상 커밋으로 Production/Ready인지 확인하세요. 프론트만 먼저 배포되고 VPS가 아직 구버전이면 새 탭은 “조건검색 서버에 연결할 수 없습니다”를 표시합니다. 이 상태는 전체 배포 성공이 아닙니다.

## 3. 키 없는 실제 웹 확인 / 보고

- `https://at-chi-six.vercel.app`에서 탭 순서와 공통 footer, GET 메타 정보, RSI·BB·MA·복합조건 검색을 확인하세요. 기준일·원시 수치와 필터 비교가 맞아야 하고 미검색/제외/0건/연결 실패를 구분해야 합니다.
- 같은 조건·snapshot의 API와 Python 직접 조회에서 종목코드·수치·정렬·페이지가 일치하는지 확인하세요. “차트”는 같은 종목을 실험실로 열고, 조건 변경은 이전 결과를 지웁니다.
- “AI로 이어가기”는 조건이 질문 초안에 반영되고 자동 전송되지 않아야 합니다. 새 AI 도구의 실제 LLM 자연어 이해 품질은 키 없는 fixture 검증과 구분하세요. 운영 유료 호출로 시도하지 마세요.
- OpenAI 키 미설정이면 기존 `/api/agent`의 `api_key_missing` 동작을 유지합니다. 수동 `/api/screener`만 성공해야 합니다. 실제 테스트 질문 저장/AI 사용량 차감은 하지 마세요.
- 이전 대화 CRUD와 기존 서비스 health를 보존하고, lab 수집/cleanup timer·paper-api·futures-lab·tailscale은 재시작하지 마세요. 수집 서비스의 기존 정책적 exit-code와 45종목 격리는 이번 범위 밖입니다.
- 보고: 최종 HEAD/clean, 각 테스트 수, 실제 운영 gate 결과, Vercel 커밋/Ready, GET/POST HTTP 상태, 두 서비스 상태, 기준일과 커버리지, 롤백 여부. 비밀값과 운영 데이터 행은 보내지 마세요.

## 개발 측 검증의 한계

로컬 fixture·합성 성능 측정은 실제 VPS 검증의 대체가 아닙니다. 2,715종목×750봉 합성 DB에서 복합 RSI/BB/MA/거래량 계산은 cold 11.04초(2,176종목), resume 2.71초(전체), cache 약 0.05초였습니다. 유효 2,665, 격리 45, 워밍업 부족 5인 합성 데이터 결과입니다. 운영 시간/건수를 보장하지 않습니다.

합성 재현: `python -m ai_agent.tests.benchmark_rsi --symbols 2715 --bars 750 --stock-screen --max-scans 4`. 이 명령은 새 임시 fixture DB만 생성하고 정리합니다.
