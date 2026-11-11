# 관리자 평가 UI v2 운영 반영

대상은 이 문서를 포함하는 `관리자탭 UI 개선` 커밋입니다. 최종 전달문에 있는 전체 SHA를 TARGET으로 지정하고 임의의 최신 main으로 바꾸지 않습니다. 운영 SQL·유료 모델·회원 변경을 개발 검증에서 실행하지 않았습니다.

## 변경과 호환성

- 새 화면: 사용가능 도구 → 평가 질문 및 실행 → 보완. 질문당 UUID/고정 표시 번호, 불변 질문 버전·실행 스냅샷, 실행당 보완 메모를 기존 평가 테이블에 저장합니다.
- 새 실행은 Node가 기존 내부 인증/loopback으로 `atlas-ai.service`의 `/health`, `/run`을 사용합니다. 운영 모델·실제 읽기 데이터·LangGraph·도구/권한/요청 한도를 공유합니다. 기존 고정 데이터 worker와 `/etc/atlas/eval.env`의 모델은 새 실행에 사용하지 않습니다.
- 원래 평가 테이블·수동 판정·고정 데이터 worker 경로를 유지합니다. 일반 대화의 평가 사례 import 버튼·전달 상태·전용 API와 프록시는 제거했습니다. 과거 질문/실행/승인/대화는 삭제하지 않습니다.
- 프런트가 먼저 배포돼도 구 API/SQL에서는 준비 중 안내와 기존 기록 열람이 가능합니다. 새 유료 실행은 SQL v2와 AI runtime 정보가 모두 확인되어야 활성화됩니다. 원래 프런트의 case/run API는 새 SQL에서도 호환됩니다.
- 새 패키지, 환경변수, 키, 공개 포트, unit 변경은 없습니다. 기존 AI 모델·단가·한도·내부 인증을 그대로 유지합니다.

## 반영 절차

1. `/opt/atlas` 현재 전체 SHA, clean 상태, detached/브랜치 상태, 서비스의 실제 User/WorkingDirectory/ExecStart/EnvironmentFiles/drop-in을 확인하고 복구 기준을 기록합니다. `git fetch origin main` 후 TARGET이 origin/main에 포함되고 현재 HEAD의 후속인지 검사합니다. 다른 변경이 있으면 보존하고 보고합니다. 기준 환경 경로는 `/etc/atlas/atlas.env`, `/etc/atlas/ai.env`, `/etc/atlas/eval.env`; 실제 unit을 우선합니다. 환경 본문·키·토큰은 출력하지 않습니다.
2. DB 복구 지점과 기존 평가 건수의 읽기 전용 집계를 확보합니다. 진행 중 일반 분석과 평가가 끝나기를 기다립니다. 기존 worker가 active라면 현재 주기 종료 후 정상 중지하고 원래 활성/자동 시작 상태를 기록합니다. queued/live 대기를 임의로 소비·취소하지 않습니다. 대기 건이 있으면 관리자가 처리 방침을 정할 때까지 전환을 보류합니다. private 스키마를 REST에 노출하지 않습니다. 직접 조회할 수 없으면 DB 담당자에게 아래 집계만 한 번에 요청합니다. 승인 대기는 보존하며 승인 버튼을 대신 누르지 않습니다.

```sql
select count(*) as analysis_running from atlas_ai.requests where status='running';
select count(*) as approval_pending from atlas_ai.requests where answer->'watchlistConfirmation'->>'status'='pending';
select r.mode,i.state,count(*) from public.ai_eval_items i join public.ai_eval_runs r on r.id=i.run_id where i.state in ('queued','running') group by r.mode,i.state;
select (select count(*) from public.ai_eval_cases) cases,(select count(*) from public.ai_eval_runs) runs,(select count(*) from public.ai_eval_items) items;
```

3. TARGET의 격리 worktree/테스트 venv에서 아래 검사를 순차 수행합니다. 기존 해시 잠금파일을 사용하고 운영 venv에 pytest를 설치하지 않습니다. 통합 검사는 `AI_TEST_PYTHON`을 격리 Python으로 지정합니다. 외부 모델·실제 회원·발송·주문은 사용하지 않습니다.

```sh
npm ci
python -m pytest ai_agent/tests -q -rs
node --test --test-concurrency=1 server/adminEval.test.js server/adminEvalProduction.test.js server/agent.test.js server/agentWatchlist.test.js server/alertAgent.test.js tests/agentProxy.test.js tests/agentWorkspace.test.js tests/evaluationRows.test.js
node --test --test-concurrency=1 tests/agentIntegration.test.js tests/marketAgentIntegration.test.js tests/fundamentalAgentIntegration.test.js tests/screenerIntegration.test.js tests/adminEvalProductionIntegration.test.js
npm run build
```

4. running/queued가 정리된 뒤 API → AI 순서로 정상 중지합니다. DB 담당자가 TARGET의 **`deploy/ADMIN_EVAL_UI_SUPABASE.sql` 전문만** SQL Editor에서 실행합니다. 기존 `AI_AGENT_SUPABASE.sql`, `AI_EVAL_SUPABASE.sql`, 알림/관심종목 SQL은 재실행하지 않습니다. 트랜잭션은 기존 데이터·판정을 보존하고 번호를 추가하며 RPC를 호환 wrapper로 전환합니다. 마지막 권한은 **false,false,true**, `numbering_errors=0`이어야 합니다. 전환 전후 cases/runs/items 건수도 같아야 합니다. service_role의 직접 테이블 쓰기는 계속 금지되어야 합니다. SQL 적용과 기대 결과를 확인할 때까지 새 API를 시작하지 않습니다.
5. clean `/opt/atlas`에서 `git merge --ff-only "$TARGET"`로 반영합니다. 패키지 잠금파일·Python requirements 변경은 없으므로 운영 의존성을 임의 업그레이드하지 않습니다. 기존 운영 venv와 DB/WAL/SHM 읽기 전용 권한을 유지합니다. 새 Python runtime 파일을 포함한 읽기 권한과 `git` 실행 가능 여부를 실제 AI 사용자로 확인합니다. runtime의 Git 조회는 해당 코드 경로에만 `safe.directory`를 지정하며 전역 Git 설정을 수정하지 않습니다.
6. **AI → API 순서로 기동**합니다. `atlas-ai.service`, `atlas-api.service`만 새 코드로 반영합니다. 기존 평가 worker는 원래 active였고 queued/live 대기를 소비하지 않는 것을 재확인한 경우에만 원상 기동합니다. 원래 inactive면 그대로 둡니다. `atlas-alert-worker`, DART/일봉 수집 timer, WAL guard, 실험실 DB와 환경파일을 변경·재시작하지 않습니다. unit 변경이 없으므로 불필요한 daemon-reload도 하지 않습니다.
7. loopback/외부 `/api/health` 200, 내부 AI 비인증 `/health`, `/run` 401을 확인합니다. 관리자 `/api/agent/admin/catalog`, `/workspace`, 질문 PUT·execute POST·메모 POST는 비인증 401이어야 합니다. 더미 UUID와 빈 JSON을 쓰고 인증된 execute는 호출하지 않습니다. 제거한 `/api/agent/admin/import/<UUID>`는 404, Vercel 내부 callback 노출도 없어야 합니다. 일반회원 403 / 관리자 200은 허용된 해당 세션이 있을 때 읽기 전용 catalog/workspace로만 확인하고 없으면 미검증으로 보고합니다. 토큰을 추출하거나 다른 회원으로 가장하지 않습니다.
8. 인증된 내부 `/health`의 runtime과 관리자 catalog.runtime.execution을 **모델명·코드 SHA·dirty=false·architecture·prompt_hash·schema_hash·역할별 도구·전체 한도**로 비교합니다. SHA가 TARGET과 일치해야 합니다. 모델명·한도는 현재 `atlas-ai` 설정과 같아야 하며 eval.env와 같게 바꿀 필요가 없습니다. 키·내부 인증 값·개인 상태는 출력하지 않습니다. 이 비교는 연결 증거이며 실제 모델의 선택/답변 품질 검증을 대신하지 않습니다.
9. Vercel Production의 대상 SHA·배포 ID·상태와 운영 도메인을 확인합니다. 관리자 세션에서 세 메뉴, 실제 등록 목록, 설명창, 기존 질문 번호·기록/메모의 읽기 전용 복원을 확인합니다. 운영 질문 추가·수정·메모 변경이나 유료 실행은 이번 배포 확인에서 하지 않습니다. 브라우저 권한/LNA 차단이나 세션 부재는 미검증 범위로 기록합니다. 유료 실행은 비용 안내를 확인한 관리자의 별도 실행으로만 진행합니다.

## 이상 시 복구

- 새 요청을 받지 않도록 API를 정상 중지하고 진행 중 호출은 자동 재시도하지 않습니다. 응답 유실은 unknown/중단으로 취급합니다. 평가 worker가 실행 중이면 먼저 정상 중지합니다.
- 기록한 이전 SHA로 승인된 운영 복구 절차에 따라 checkout하고 AI → API 순서로 다시 기동합니다. 필요한 경우 Vercel도 기록한 직전 정상 Production으로 되돌립니다. 다른 작업을 강제 push/reset하지 않습니다.
- 이번 SQL은 구 case/run API를 유지하므로 **추가 스키마와 데이터는 그대로 둡니다.** base SQL 재실행, 테이블/메모/이력 삭제, DB 전체 복원은 하지 않습니다. SQL 자체가 실패했다면 트랜잭션 rollback 여부를 확인하고 기존 서비스로 복귀합니다.
- 새 production 실행이 남아 있으면 비용·응답 상태를 확인하기 전 재실행하지 않습니다. 새 API의 workspace는 3분 초과 running을 interrupted/사용량 unknown으로만 표시하며 자동 모델 재호출을 하지 않습니다. 이전 고정 데이터 worker도 완료되지 않은 paid 호출을 재실행하지 않습니다.
- 보존한 환경/DB/unit의 해시와 health/401을 확인하고 기존 활성 서비스만 원상 복원합니다.

보고: 이전/적용 SHA, SQL 확인 주체·권한/번호/건수 결과, 테스트·서비스, runtime 모델/버전 일치, Vercel SHA/배포 ID/운영 도메인, 확인한 인증 역할, 실제 유료 호출 없음, 미검증 운영 UI/실제 모델 범위. 비밀값·개인 대화/메모 원문은 출력하지 않습니다.
