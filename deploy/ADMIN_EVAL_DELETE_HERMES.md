# 관리자 평가 질문 삭제 운영 반영

대상은 `관리자탭 평가 질문 및 실행 질문 삭제 구현` 커밋의 **전달받은 전체 SHA**입니다. 임의의 최신 커밋으로 바꾸지 않습니다.

## 동작과 호환성

- 질문별 삭제와 여러 페이지 전체 선택 삭제를 제공합니다. UUID·질문 버전으로 대상을 확인하며, 다른 화면에서 수정된 질문이 포함되면 전체 삭제를 거절합니다.
- 질문의 모든 버전에 삭제 표식을 남기고 질문·보완 목록에서 제외합니다. 남은 질문은 두 화면에서 동일한 1부터의 표시 번호를 사용합니다. 실행 스냅샷·사용량·비용·보완 메모·감사 기록은 보존합니다.
- 실행/대기 중인 대상은 삭제하지 않으며 평가를 취소하거나 재실행하지 않습니다. 이전 저장·실행 API로 삭제된 질문을 되살릴 수 없습니다.
- SQL은 기존 UI v2를 감싸는 추가 마이그레이션입니다. `ui_status.version=2`는 유지하고 `questionDeletionVersion=1`을 추가합니다. SQL이 아직 없으면 새 화면의 삭제 기능은 활성화되지 않습니다. 구 API도 추가 SQL에서 기존 조회·저장을 사용할 수 있습니다.
- 프런트와 Node API/프록시 변경입니다. Python·모델·프롬프트·의존성·환경변수·systemd unit 변경은 없습니다.

## 반영 순서

1. `/opt/atlas`의 SHA(OLD), clean 상태, checkout 형태, 실제 API unit의 User/WorkingDirectory/ExecStart/환경파일 경로와 기존 서비스 상태를 기록합니다. `git fetch origin main` 후 TARGET이 origin/main에 포함되고 OLD의 후속인지 확인합니다. 작업 트리가 변경되었으면 덮어쓰지 않습니다. OLD..TARGET의 전체 변경을 검토하여 별도 미배포 서버 기능이 섞여 있으면 그 기능의 지침까지 확인합니다. 비밀값과 환경파일 본문은 출력하지 않습니다.
2. 복구 가능한 현재 Supabase 백업/복구 지점을 확보하고 cases/runs/items 건수를 기록합니다. 과거 마이그레이션 전 백업이라고 오인하지 않습니다. 운영 질문을 삭제하거나 표본 데이터를 만들지 않습니다.
3. TARGET 격리 worktree에서 잠금파일로 개발 의존성을 설치하고 다음을 실행합니다. 운영 의존성은 변경하지 않습니다.

```sh
npm ci
node --test --test-concurrency=1 server/adminEval.test.js server/adminEvalProduction.test.js server/adminEvalDeletion.test.js server/adminEvalDeletionDb.test.js tests/agentProxy.test.js tests/evaluationRows.test.js
npm run build
```

4. 기존 Node API가 직접 처리하는 production 평가와 일반 분석 요청이 끝나고 API 연결이 정리되기를 기다립니다. 실행 중인 요청을 강제로 중단하거나 유료 실행을 재시도하지 않습니다. API만 정상 중지합니다. **AI·평가 worker·알림 worker·DART/일봉 수집·WAL guard는 중지하거나 재시작하지 않습니다.**
5. DB 담당자가 TARGET의 `deploy/ADMIN_EVAL_DELETE_SUPABASE.sql` **전문만** SQL Editor에서 실행합니다. `AI_EVAL_SUPABASE.sql`, `ADMIN_EVAL_UI_SUPABASE.sql`, 그 밖의 SQL은 재실행하지 않습니다. 적용만으로 기존 질문이 삭제되지 않아야 합니다. 마지막 확인 결과:
   - RPC marker: `atlas-eval-delete-v1`
   - 최상위 RPC 실행 권한(anon/authenticated/service_role): `false,false,true`
   - 하위 v2/v1 RPC 및 목록 함수 직접 실행: 세 역할 모두 `false`
   - 세 테이블 직접 SELECT/INSERT/UPDATE/DELETE: 세 역할 모두 `false`; RLS 유지
   - `mixed_deletion_errors=0`, 기존 cases/runs/items 건수 유지
   실패하면 트랜잭션 커밋 여부를 확인하고 코드를 전환하지 않습니다. 삭제 표식을 지우거나 과거 SQL을 재실행해 복구하지 않습니다.
6. clean `/opt/atlas`에서 `git merge --ff-only "$TARGET"`로 반영하고 **`atlas-api.service`만 기동**합니다. 기존 checkout 방식과 사용자·환경을 유지합니다. `daemon-reload`, 키 추가, DB/WAL/SHM 변경은 필요 없습니다.
7. readiness 재시도로 loopback과 기존 외부 `/api/health`의 200을 확인합니다. 비인증 `GET /api/agent/admin/questions/selection`, `POST /api/agent/admin/questions/delete`는 loopback·외부·Vercel 동일 출처 프록시에서 401이어야 합니다. POST 검사는 빈 JSON으로만 하고, 인증된 삭제 요청은 보내지 않습니다. 임의 Origin은 거부해야 합니다.
8. 허용된 관리자 세션이 있으면 읽기 전용 catalog/workspace/selection으로 `features.questionDeletion=true`, 현재 번호·개수·기존 보완 내용 보존을 확인합니다. 일반회원은 403이어야 합니다. 운영 질문 삭제·수정·유료 평가 실행은 검증 목적으로 하지 않습니다. 회원 세션이 없으면 이 부분은 미검증으로 보고합니다. 세션 토큰을 추출하거나 관리자를 가장하지 않습니다.
9. Vercel Production의 SHA/배포 ID/상태와 운영 도메인의 대상 번들을 확인합니다. 프런트 자동 배포와 VPS/SQL 반영을 각각 보고합니다. 운영 관리자 화면에서 체크박스·행별 삭제·전체 선택·확인창 취소까지 확인할 수 있으나 **실제 삭제 확인은 누르지 않습니다.** 라이트·다크·모바일 표시도 확인합니다.
10. 신규 5xx/uncaught 오류가 없는지 확인하고, 무관한 서비스·환경·DB 파일이 보존되었는지 기록합니다. 질문 원문·회원 식별자·비밀값을 로그에 출력하지 않습니다.

## 실패 시 복구

- API만 정상 중지하고 기록한 OLD로 강제 reset 없이 기존 운영 방식에 맞춰 checkout한 뒤 API만 다시 기동합니다. 새 요청·진행 중 유료 실행을 자동 재호출하지 않습니다.
- 추가 SQL/삭제 표식/질문 버전/실행 기록은 그대로 유지합니다. 구 API는 추가 SQL과 호환됩니다. 삭제된 질문을 되살리기 위해 `deleted_at`을 비우거나 base SQL을 재실행하지 않습니다. 전체 DB 복원·이력 삭제도 하지 않습니다.
- 필요하면 Vercel을 기록한 직전 정상 Production으로 되돌립니다. GitHub 강제 push는 하지 않습니다.
- health/비인증 거부와 기존 서비스 상태를 다시 확인합니다. 결과에는 OLD/TARGET, SQL 적용 주체와 확인 결과, 테스트, Vercel/VPS 각각의 상태, 운영 데이터 변경 없음과 미검증 항목을 구분합니다.
