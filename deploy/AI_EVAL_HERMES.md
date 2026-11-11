# VPS 헤르메스 전달 지시문

> 과거 고정 합성 데이터 평가 worker의 최초 설치 기록입니다. 현재 관리자 행별 실행 UI의 반영은 [ADMIN_EVAL_UI_HERMES.md](./ADMIN_EVAL_UI_HERMES.md)를 따릅니다. 신규 실행은 운영 `atlas-ai.service`를 사용하며 이 문서의 별도 모델·키 설정을 새 UI에 적용하지 않습니다. 기존 평가 이력·worker 호환 경로를 위해 이 기록은 보존합니다.

GitHub main의 `관리자 탭 AI 품질개선` 커밋을 배포한다. 전달받은 최종 전체 SHA를 TARGET_SHA로 사용한다. 최신 main을 무조건 적용하지 않는다. 유료 OpenAI 평가·실제 회원 데이터 변경·카카오 발송은 실행하지 않는다.

1. `/opt/atlas`의 현재 SHA와 clean 상태, 실행 사용자·경로·systemd unit·환경파일을 확인한다. 이전 SHA를 기록한다. 다른 미배포 작업이 있으면 덮어쓰지 않고 보고한다. 기존 코드의 운영 기본값은 API `/etc/atlas/atlas.env`, AI `/etc/atlas/ai.env`이며 실제 unit을 우선한다.
2. DB 담당자가 `deploy/AI_EVAL_SUPABASE.sql` 전문을 적용했는지 확인한다. 마지막 RPC 권한은 anon=false, authenticated=false, service_role=true다. `admin_users`와 평가 테이블에 브라우저 직접 접근이 없어야 한다. `deploy/AI_EVAL_ADMIN.sql`의 UID는 운영자가 직접 입력한다. UID·키·토큰을 배포 보고서에 출력하지 않는다. SQL Editor에서만 조회했다고 회원 역할 격리까지 확인한 것으로 보고하지 않는다.
3. `git fetch origin` 후 대상이 origin/main에 포함되는지 검증한다. 작업 트리가 clean이고 현재 커밋이 대상의 조상일 때 `git merge --ff-only "$TARGET_SHA"`로 적용한다. 잠금파일 변경 여부를 확인하고 필요 시 npm ci를 수행한다. Node 런타임 의존성 추가는 없다. Python은 기존 `.venv-ai`의 잠금 의존성을 재사용하며 pytest 등을 운영 venv에 추가하지 않는다. `npm run build`를 확인한다.
4. 시스템 계정 `atlas-eval`을 홈·로그인 셸 없이 생성한다(이미 존재하면 재생성하지 않음). `/opt/atlas`의 소스와 `.venv-ai`에 읽기·탐색 권한만 제공한다. 운영 `/var/lib/atlas/lab.sqlite`와 운영 환경파일 읽기 권한을 제공하지 않는다. `deploy/atlas-eval-worker.service`를 `/etc/systemd/system/`에 설치하고 환경파일·실행 사용자 경로를 실제 환경과 맞춘다. 별도 worker가 포트를 열지는 않으며 고정 loopback `127.0.0.1:3000`에 연결한다. API가 다른 포트라면 코드와 unit의 검토된 변경이 필요하며 임의 URL을 열지 않는다.
5. 기존 `/etc/atlas/atlas.env`에 `AI_EVAL_SECRET`을 추가한다. 이미 있으면 보존한다. 새 값이 필요하면 서버에서 충분한 난수로 생성해 파일로만 저장하며 터미널·보고서에 출력하지 않는다. 이 값을 `/etc/atlas/eval.env`에도 동일하게 설정한다. 기존 환경파일 전체를 덮어쓰거나 eval.env로 복사하지 않는다.
6. `/etc/atlas/eval.env`는 root 소유, atlas-eval 그룹, 0640으로 생성한다. 다음 변수만 필요한 값으로 제공한다:
   - `AI_EVAL_SECRET`: API와 동일한 전용 내부 인증 비밀
   - `OPENAI_API_KEY`: 운영자가 제공하는 평가용 키; 가능하면 별도 프로젝트·예산 사용
   - `OPENAI_MODEL`: 현재 평가할 모델명(일반 AI 서비스와 비교 가능하도록 명시)
   - `AI_INPUT_USD_PER_MILLION`, `AI_OUTPUT_USD_PER_MILLION`: 사용하는 모델에 맞춘 보수적인 추정 단가
   - `AI_CALENDAR_THROUGH`: 현재 검토된 달력 범위, 필요 시 기존 값 확인
   브로커 키, 카카오 키, Supabase service key, 운영 LAB_DB_PATH를 넣지 않는다. worker는 고정 합성 DB를 PrivateTmp 안에 만든다. 가격은 추정치이며 정확한 청구 상한 보장은 아니다.
7. systemctl daemon-reload 후 `atlas-api.service`를 재시작하고 `atlas-eval-worker.service`를 enable --now 한다. 기존 `atlas-ai.service`를 평가용으로 대체하지 않는다. alert-worker와 DART/lab 타이머를 재시작하지 않는다. worker는 대기 중 작업이 없으면 LLM을 호출하지 않는다. 대기 중인 실제 평가가 있으면 시작할 수 있으므로 처음 시작·업데이트 전 큐를 확인하고 원치 않는 대기 작업은 관리자가 취소한다.
8. API health, worker active 상태, 비인증 `/api/agent/admin/status`=401을 확인한다. 평가 endpoint 내부 비인증 요청도 401이어야 한다. 관리자 페이지에서 실행기 연결·실제 SHA·모델 설정이 보이는지 운영자가 확인한다. 일반 회원 403과 관리자 200은 해당 역할로 검증한 경우만 확인 완료로 보고한다. 사용자 로그인 자격증명을 요구하지 않는다.
9. 관리자 화면에서 초기 사례 등록과 코드 검증 모드는 유료 호출 없이 확인 가능하다. 실제 모델 모드는 운영자가 비용·예산 확인 후 직접 실행한다. 배포만으로 실행하지 않는다. 이번 배포 검증에서 실제 모델 평가를 수행하지 않았음을 명시한다.
10. Vercel은 기존 `/api/agent/*` 프록시와 `ATLAS_API_ORIGIN`을 재사용한다. 새 VITE 변수나 비밀키는 없다. Production 배포 SHA와 상태를 확인한다. Git push 성공만으로 웹/VPS 배포 완료를 주장하지 않는다.
11. 복구 시 평가 worker를 먼저 정지한다. 진행 중 호출은 비용 미확인일 수 있으므로 재실행하지 않는다. 이전 코드 SHA로 운영 절차에 따라 복귀하고 API를 재시작한다. 신규 평가 테이블을 삭제하지 않는다. 권한 차단이 필요하면 admin_users에서 대상 UID를 삭제한다. 일반 계정·기존 알림 데이터는 그대로 둔다. 이전 worker가 중단한 항목은 재기동 후 5분 heartbeat 만료 시 interrupted가 되며 자동 재실행하지 않는다.

보고: 적용 SHA, SQL·최초 관리자 등록의 확인 주체, 서비스 상태, Vercel SHA, 검사한 인증 역할, 코드 검증/실제 모델 평가 여부, 미확인 항목. 키·인증 토큰·대화 원문은 출력하지 않는다.
