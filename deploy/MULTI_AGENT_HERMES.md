# VPS 헤르메스 전달문

ATLAS main의 최종 보고에 적힌 전체 SHA를 대상 커밋으로 사용해 분석 AI 그래프를 반영해 주세요. 아래 단계는 분석 API·평가 실행기에만 적용합니다.

## 사전 확인

1. `/opt/atlas`의 현재 HEAD 전체 SHA를 복구 대상으로 기록합니다. 작업 트리와 staged 변경이 모두 없는지 확인하고, 원격 main을 fetch한 뒤 대상 SHA가 원격 main에 포함되는지와 이전 HEAD의 후속인지 검사합니다. 불일치가 있으면 기존 작업을 보존한 상태로 중단하고 보고합니다.
2. 실제 systemd의 WorkingDirectory·User·EnvironmentFiles·ExecStart와 drop-in을 확인합니다. 저장소 기준은 `atlas-api.service`, `atlas-ai.service`, `atlas-eval-worker.service`이며 AI는 `/opt/atlas/.venv-ai/bin/python`, `127.0.0.1:8010`, `/etc/atlas/ai.env`를 사용합니다. 평가 worker는 같은 Python으로 `/etc/atlas/eval.env`를 사용합니다. 환경파일 본문·키·토큰을 출력하지 않습니다.
3. Supabase의 기존 분석 running 요청, 관리자 queued/running 평가, 관심종목 확인 대기의 상태별 건수만 확인합니다. 질문·회원 ID·행 원문은 출력하지 않습니다. 진행 중 분석은 기존 120초 실행·180초 lease 정책에 따라 마무리되도록 기다립니다. 평가 worker는 현재 실행이 끝나도록 정상 중지합니다. 대기 중인 live 평가가 있으면 이번 무과금 배포 검증에서 소비하지 않도록 worker 재시작을 보류하고 사용자에게 알립니다. 승인 대기 카드는 DB에 유지하며 삭제하거나 재생성하지 않습니다.

## 검증과 반영

4. 신규 SQL·정리 SQL·테이블 변경·LangGraph 체크포인트 준비는 불필요합니다. 기존 AI_AGENT/AI_EVAL/WATCHLIST/ALERT SQL을 재실행하지 않습니다. 영속 요청·답변·단계·확인 상태는 기존 Supabase 구조를 재사용합니다. 실행 중 그래프를 재생하는 checkpoint/thread resume 경로는 없습니다. 재시작 시 기존 lease 만료와 unknown 사용량 정산으로 종료하고 유료 호출을 자동 재실행하지 않습니다.
5. 대상 SHA의 별도 worktree와 격리 테스트 venv를 준비합니다. 실제 Python 버전을 확인하고 Python 3.10 이상에서 `python -m pip install --require-hashes -r ai_agent/requirements-test.lock`을 실행합니다. `python -m pytest ai_agent/tests -q -rs`, `node --test server/agent.test.js server/agentWatchlist.test.js server/adminEval.test.js tests/agentWorkspace.test.js`, `node --test --test-concurrency=1 tests/agentIntegration.test.js tests/screenerIntegration.test.js`, `npm ci`, `npm run build`를 실행합니다. 테스트 준비에 npm ci가 필요하면 Node 검사보다 먼저 실행합니다. 통합 검사는 `AI_TEST_PYTHON`을 격리 테스트 Python 경로로 지정합니다. Linux에서 필요한 읽기 전용 SQLite/WAL 기존 gate도 AI 사용자로 확인합니다. 테스트 데이터만 사용하며 운영 DB·관심종목·알림 규칙·메시지를 변경하지 않습니다. 운영 Python에 pytest를 설치하지 않습니다.
6. 운영 요청이 정리됐고 격리 검사가 통과한 뒤 API → AI 순서로 정상 중지합니다. 운영 checkout을 `git merge --ff-only <대상 전체 SHA>`로 반영합니다. 기존 Python 환경을 복구 가능하게 보존하고 `/opt/atlas/.venv-ai/bin/python -m pip install --require-hashes -r /opt/atlas/ai_agent/requirements.lock`을 실행합니다. 기존 SDK·모델은 유지하고 LangGraph 1.2.20 및 고정 전이 의존성의 설치·해시 검사를 확인합니다.
7. 새 환경변수·키·URL·공개 포트 설정은 필요하지 않습니다. 기존 `OPENAI_MODEL`, `OPENAI_API_KEY`, `AI_INTERNAL_SECRET`, `AI_CALLBACK_URL`, 분석 예산 설정과 평가 인증 설정을 유지합니다. 총괄·세 전문 담당이 동일한 모델을 사용합니다. 요청 기본 한도는 모델 8회·도구 12회·40,000토큰·추정 $0.25·120초이며 병렬 담당 2개·위임 배치 2회입니다. 기존 운영 한도가 있으면 유지하고 값을 임의로 늘리지 않습니다.
8. `atlas-ai.service`를 먼저 시작하여 기존 내부 인증을 사용한 loopback `/health`가 200이며 `architecture=atlas-langgraph-v1`, 기존 모델, `alert_tools=true`인지 확인합니다. AI는 loopback만 리스닝하고 비인증 health/run 접근은 거부돼야 합니다. `atlas-api.service`를 시작하여 loopback·외부 `/api/health` 200과 비인증 관리자 평가 접근 거부를 확인합니다. 기존 게스트 서명 쿠키 경로는 유지합니다. 내부 callback은 기존 인증·running 요청 검증을 유지하고 공개 프록시로 새로 노출하지 않습니다.
9. 기존에 실행 중이었고 무승인 live 평가 대기가 없는 경우에만 `atlas-eval-worker.service`를 원상 재시작합니다. worker가 새 코드 SHA·구조·프롬프트/도구 hash를 보고하는지 확인합니다. 운영 평가를 임의로 enqueue하지 않습니다. 고정 응답 코드 검증을 실행할 경우 실제 모델 비용이 0이고 동일 운영 그래프·전문 담당·도구 경로를 거치는지 확인합니다. 실제 모델 담당 선택·품질 향상은 이번에 미검증으로 기록합니다.

## 프런트와 운영 확인

10. main 연동 Vercel Production의 대상 SHA·상태·배포 ID와 운영 도메인 반영을 별도로 확인합니다. 프런트는 이전 단일 구조의 기록도 표시할 수 있고 Node/Python 응답의 기존 핵심 계약을 유지합니다. 권한이 있는 회원의 읽기 전용 UI에서 기존 대화, 담당별 실행 기록, 사용가능 도구와 담당, 과거 점검 SHA·시각 유지, 라이트·다크·좁은 화면을 확인합니다. 기존 DB의 확인 대기 카드를 열람할 수 있습니다. 실제 모델 호출, 승인 버튼, 알림 저장·취소·시작, 카카오 발송은 이번 검증에서 실행하지 않습니다. 세부 화면을 확인할 세션이 없으면 미검증으로 보고합니다.
11. 기존 `lab.sqlite`·WAL/SHM·수집 일정·WAL guard·알림 worker·카카오 설정·DART 작업·환경파일은 보존합니다. 이번 변경에 삭제하거나 재설치할 systemd unit은 없습니다.

## 실패 시 복구

12. 신규 분석과 평가 실행을 중지하고 이미 시작된 요청은 실패·unknown으로 정산되도록 합니다. 진행 중 유료 요청을 다시 제출하지 않습니다. 작업 트리가 clean인지 확인한 뒤 기록한 이전 SHA로 checkout을 복구하고 보존한 Python 환경을 복원하거나 이전 커밋의 requirements.lock을 해시 검증하여 재설치합니다. 기존 실행 사용자·환경파일·인증·포트를 유지하고 AI → API 순서로 기동합니다. 평가 worker는 기존 실행 상태와 live 대기 여부에 따라 복원합니다.
13. DB 스키마 변경이 없으므로 DB 롤백·데이터 삭제 SQL은 실행하지 않습니다. 기존 회원·관심종목·알림·대화·평가·승인 이력을 보존합니다. 프런트 문제가 있으면 직전 정상 Vercel Production 배포를 복구하고 서버 복구와 구분해 보고합니다. 이전/현재 SHA·서비스 상태·health·미검증 범위를 비밀값 없이 보고해 주세요.
