# VPS 헤르메스 전달문

ATLAS `https://github.com/swon218/AT.git`의 `main`에 커밋 메시지 **AI 에이전트 구현**으로 반영된 실제 조사 에이전트를 배포해 주세요. 배포할 정확한 커밋 해시는 사용자가 전달한 최종 답변의 해시와 대조하세요. 운영 Supabase SQL 적용은 사용자가 먼저 수행합니다. 이번 전달에서 별도 승인 없이 유료 모델을 호출하지 마세요.

## A. 키 없이 설치·진단

1. 먼저 실제 경로를 조사하세요. `/opt/atlas`, `atlas-api.service`, `/etc/atlas/atlas.env`, `/var/lib/atlas/lab.sqlite`, `.venv-lab`은 기존 문서의 후보이며 현재 운영 확인 사실이 아닙니다. 아래 명령으로 서비스 경로/사용자/환경파일 위치만 확인하고 환경변수 값, `.env`, Authorization 헤더, 개인 대화는 출력하지 마세요.

```sh
sudo systemctl show atlas-api.service -p WorkingDirectory -p User -p Group -p FragmentPath -p EnvironmentFiles
sudo ss -ltnp
sudo systemctl list-timers --all
```

실제 경로에 맞춰 아래 변수와 템플릿을 조정하세요. `WEB_ORIGIN`과 `API_ORIGIN`은 실제 Vercel 웹/HTTPS API origin을 확인한 뒤 입력하며 과거 배포 URL만으로 단정하지 마세요.

```sh
read -r -p 'Verified checkout path: ' APP
read -r -p 'Verified Node env file: ' NODE_ENV_FILE
read -r -p 'Verified lab SQLite path: ' LAB_DB
read -r -p 'Verified HTTPS web origin: ' WEB_ORIGIN
read -r -p 'Verified HTTPS API origin: ' API_ORIGIN
read -r -p 'Verified Node loopback port: ' NODE_PORT
read -r -p 'Target commit from user: ' TARGET_COMMIT
cd "$APP"
git status --short
git branch --show-current
git remote get-url origin
git rev-parse HEAD
```

2. 기존 checkout/환경파일/서비스 정의/DB를 비공개 백업하세요. DB 백업은 일관된 Supabase 백업/`pg_dump`와 SQLite backup API를 사용하고 운영 수집 파일을 초기화하지 마세요. `.env` 백업에는 키가 있으므로 root 전용 0700 디렉터리/0600 파일로 관리하며 Git에 넣거나 채팅에 붙이지 마세요. 추적 변경은 비공개 patch로, 필요한 untracked/ignored 파일은 별도 백업하세요. 작업 트리가 깨끗하지 않으면 사용자 변경을 보존한 뒤 진행하고 `reset --hard`, 강제 push, 무조건적인 덮어쓰기는 금지합니다.

```sh
git fetch origin main
git pull --ff-only origin main
git merge-base --is-ancestor "$TARGET_COMMIT" HEAD
git show -s --format='%H %s' "$TARGET_COMMIT"
npm ci
```

예상 해시/원격/브랜치가 다르면 배포를 멈추고 차이를 보고하세요. 최종 전달 해시의 코드가 배포 대상이며 이후 다른 커밋이 붙었다면 그 변경도 확인해야 합니다.

3. **사용자가 `deploy/AI_AGENT_SUPABASE.sql` 또는 동일 migration 중 하나를 SQL Editor에서 실행한 것이 선행 조건입니다.** 운영 SQL을 헤르메스가 임의로 대신 적용하지 마세요. postcheck에서 8개 테이블의 RLS, 직접 client 접근 차단, anon/authenticated RPC=false, service_role RPC=true를 확인하도록 요청하세요. Node 환경의 기존 SUPABASE_URL/PUBLISHABLE_KEY/SECRET_KEY가 같은 프로젝트를 가리키는지 값 출력 없이 확인하세요. 기존 broker 암호화 키와 DB는 보존합니다.

4. AI 전용 가상환경을 별도로 만드세요. 기존 `.venv-lab`은 그대로 둡니다. Python 3.10 이상이 필요하며 pip는 잠금 파일의 해시까지 검증합니다.

```sh
python3 -m venv "$APP/.venv-ai"
"$APP/.venv-ai/bin/python" -m pip install --require-hashes -r ai_agent/requirements.lock
```

5. 전용 시스템 사용자 `atlas-ai`를 준비하고 코드/가상환경을 읽고 실행할 권한, 확인된 SQLite와 존재하는 WAL/SHM의 읽기 권한만 부여하세요. Node 환경파일·브로커 키·암호화 키·계좌 파일은 읽을 수 없어야 합니다. 기존 서비스 그룹에 무조건 추가하거나 `/etc/atlas` 전체 읽기 권한을 주지 마세요. 필요하면 파일별 ACL을 쓰고 수집기가 WAL을 다시 만들 때 권한이 유지되는지도 확인하세요. read-only SQLite가 WAL을 안전하게 읽을 수 있어야 하며 `immutable=1`로 최신성 문제를 숨기지 마세요.

6. Node와 AI 환경을 분리하세요. 다음 스크립트는 필요한 AI 값만 추가하고 기존 비어 있지 않은 값은 보존합니다. 내부 공유 비밀/guest 서명키는 출력하지 않고 생성합니다. 실제 Node가 읽는 파일을 정확히 지정하세요. 기존 내부 비밀이 서로 다르면 스크립트는 중단합니다.

```sh
sudo python3 deploy/ai_prepare.py --node-env "$NODE_ENV_FILE" --ai-env /etc/atlas/ai.env --origin "$WEB_ORIGIN" --lab-db "$LAB_DB" --node-port "$NODE_PORT"
sudo chmod 600 "$NODE_ENV_FILE" /etc/atlas/ai.env
```

`/etc/atlas/ai.env`는 systemd가 읽으며 AI 프로세스에는 이 파일만 전달합니다. Node 실제 환경파일에는 `AI_ENABLED`, `AI_PUBLIC_ORIGIN`, `AI_INTERNAL_URL`, `AI_INTERNAL_SECRET`, `AI_GUEST_COOKIE_SECRET`, `AI_GUEST_DAYS`를 적용합니다. Node가 production으로 실행되도록 기존 설정을 확인하세요. AI 파일은 `OPENAI_MODEL=gpt-6-luna`, 빈 `OPENAI_API_KEY`, 같은 `AI_INTERNAL_SECRET`, Node 실제 port의 `AI_CALLBACK_URL`, `LAB_DB_PATH`, 필요한 Naver 쌍 및 AI 한도만 갖습니다. **Node `.env` 전체를 AI 파일로 복사하거나 AI systemd에 함께 연결하지 마세요.** `.env.example`은 활성 설정이 아니고 로컬 `.env` 수정은 VPS에 자동 전달되지 않습니다.

기존 Naver developer-center 키를 사용할 때 `AI_NAVER_MODE=legacy` 및 전용 `AI_NAVER_CLIENT_ID/SECRET`에 필요한 쌍만 안전하게 설정하세요. API HUB로 이관한 경우 `hub`와 새 NCP 쌍을 사용합니다. 경로와 헤더는 코드에서 모드에 따라 선택합니다. 기존 키는 2027-06-30 지원 종료 공지를 확인했으며, 실제 운영 키의 신청/이관 상태는 별도 확인 사항입니다. 키 값을 출력하지 마세요.

7. `deploy/atlas-ai.service`를 실제 checkout/사용자/환경파일/포트에 맞춰 설치하세요. AI는 `127.0.0.1:8010`, worker 1개가 기본이며 포트를 바꾸면 Node URL과 진단 명령도 함께 맞춥니다. 외부 reverse proxy에 AI `/run`·`/health`를 공개하지 마세요. Node `/api/internal/agent/events`도 외부 proxy에서 차단하고 Node loopback callback만 허용하세요. 보통 Node 공개 API는 기존 HTTPS proxy 뒤에 남고 서버 간 인증은 그대로 적용됩니다.

```sh
sudo install -m 644 deploy/atlas-ai.service /etc/systemd/system/atlas-ai.service
sudo systemctl daemon-reload
sudo systemctl enable --now atlas-ai.service
sudo systemctl restart atlas-api.service
sudo systemctl is-active atlas-ai.service atlas-api.service
sudo python3 deploy/ai_check.py --ai-env /etc/atlas/ai.env
```

진단은 유료 호출을 하지 않습니다. 키 없이 `ok=true`, `key_configured=false`, `provider.state=api_key_missing`가 정상입니다. `lab_ready`/`news_configured`는 각각 파일 존재/키 존재이며 실제 데이터 품질/연결 성공 증거가 아닙니다. 네트워크/권한/DB 준비 실패와 데이터 없음은 구분해 보고하세요. AI 사용자 권한으로 읽기 전용 도구를 실행해 종목 수/최신 확정일/제외 사유를 확인하되 개인 자료와 원문은 출력하지 마세요. 임시 휴장·거래시간 변경을 점검하고 달력 기본 검증 범위 `AI_CALENDAR_THROUGH=2026-12-31`를 임의 연장하지 마세요.

8. Vercel **서버** 환경에 `ATLAS_API_ORIGIN=$API_ORIGIN`을 설정하고 새 프런트엔드를 배포하세요. VITE_에 비밀값을 넣지 마세요. 브라우저는 `/api/agent`만 호출하고 Vercel 서버 함수가 HTTPS API로 프록시합니다. 사용자 브라우저에서 Secure/HttpOnly/Host-only/SameSite=Lax 쿠키가 실제 웹 도메인에 저장되는지 확인하세요. Node의 `AI_PUBLIC_ORIGIN`과 실제 Origin이 같아야 합니다. API를 브라우저가 직접 cross-site 호출하도록 바꾸지 마세요. CORS credentials에 의존하지 않으며 쿠키 차단/위조/만료 시 오류를 안내하고 매번 새 방문자를 자동 발급하지 않습니다. 쿠키 삭제·다른 브라우저의 동일인 식별 완벽 보장은 없습니다.

Vercel deployment의 commit/빌드/ready 및 실제 웹의 `/api/agent/status`를 확인하세요. GitHub push만으로 Vercel 배포 성공이라고 보고하지 마세요. API 키 없이 guest/로그인 방 생성·제목 변경·삭제·기록 조회·초안 공유·새로고침 복원과 API 키 미설정 오류를 점검하세요. 키 미설정 요청이 하루 사용량을 차감하지 않는지 확인하세요. API 키가 없는 동안 테스트 답변을 production에서 대신 표시하지 마세요.

9. `deploy/atlas-ai-cleanup.service`의 Node 실행 경로/사용자/checkout/환경파일을 기존 Node에 맞추고 timer를 설치하세요. AI 테이블만 정리하며 기존 일봉 수집 timer, 뉴스, 주문, 자산 서비스는 보존하세요.

```sh
sudo install -m 644 deploy/atlas-ai-cleanup.service /etc/systemd/system/atlas-ai-cleanup.service
sudo install -m 644 deploy/atlas-ai-cleanup.timer /etc/systemd/system/atlas-ai-cleanup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now atlas-ai-cleanup.timer
sudo systemctl start atlas-ai-cleanup.service
sudo systemctl is-active atlas-ai-cleanup.timer
```

guest 기본 7일, steps 30일, request 본문 90일 정책입니다. 사용량/최소 익명 요청 메타데이터는 채팅 삭제와 분리 유지합니다. public news cache는 60초/256개이며 메모리에서 만료·재시작으로 정리됩니다. 방 삭제는 메시지/질문 본문을 제거하며 늦은 결과가 다시 방을 만들지 않습니다. 직접 정리가 필요하면 기존 Node 환경이 적용된 상태에서 `node deploy/ai_maintenance.js`를 실행하세요. service_role 키를 명령 인자나 로그에 넣지 마세요.

## B. 사용자의 결제·키 발급 이후

10. 사용자가 서버 환경파일 `/etc/atlas/ai.env`에 직접 `OPENAI_API_KEY`를 넣도록 안내하고 `atlas-ai.service`만 재시작하세요. 키를 채팅/SQL/Git/Vercel VITE_ 변수에 넣지 마세요. 상태가 `configured`라는 것은 키 존재만 의미하며 실제 연결 성공과 다릅니다.

11. **유료 실제 모델 호출은 그 시점에 사용자 승인을 받은 뒤** 진행하세요. 처음에는 질문 3건 이내, 요청별 모델 8회/도구 12회/120초/40,000토큰/보수 예산 0.25달러 설정을 유지하세요. 이 금액은 실제 청구 보장이 아니므로 활성 요율과 계수부터 확인하세요. 개념 질문 1건, 단일 뉴스 1건, RSI+뉴스 복합 1건 순으로 점검하고 실패 시 반복 호출하지 마세요. 뉴스·RSI 자료가 준비되지 않으면 자료 미준비로 보고하고 이를 모델 연결 실패라고 바꾸어 말하지 마세요.

사용자 동의 없이 guest 제한 검증을 위해 추가 유료 질문을 늘리지 마세요. guest 1·2회/3회 거부, 로그인 일일 무제한, 소유권·동시성·날짜 변경은 저장소의 fixture 테스트로 먼저 검사하고 실제 유료 호출 추가는 별도 승인을 받으세요.

12. 요청 상세에서 usage의 **모든 왕복 누적** input_tokens/output_tokens/reasoning_tokens/cached_tokens/model_calls/status를 확인하세요. reasoning은 output 안에 포함되므로 이중 합산하지 않습니다. unknown은 0원/0토큰으로 바꾸지 마세요. 안전한 SQL 확인 예시는 아래이며 질문/답변/헤더/전체 프롬프트는 출력하지 않습니다.

```sql
SELECT id,status,created_at,usage,error_code FROM atlas_ai.requests ORDER BY created_at DESC LIMIT 10;
SELECT request_id,seq,event->>'name' AS tool,event->>'status' AS status,event->>'elapsed_ms' AS elapsed_ms FROM atlas_ai.steps ORDER BY created_at DESC LIMIT 30;
```

해당 질의는 운영자 본인이 SQL Editor에서 확인할 수 있습니다. 헤르메스는 사용자 승인 없이 운영 DB를 변경하지 마세요. 첫 성공 후 `recent_success`와 `last_success_at`을 확인하고, 결제/권한 오류와 연결 실패를 각각 보고하세요. 실제 기사의 관련성·내용 부합·부정/긍정 설명·후속 질문의 앞선 출처 참조도 사람이 점검하세요. fixture 통과를 실제 판단 품질 검증으로 대신하지 마세요.

## 비활성화·복구

AI만 중지하려면 실제 Node 환경파일의 `AI_ENABLED=false` 후 `atlas-api.service`를 재시작하세요. 기존 대화는 계속 조회 가능합니다. 필요하면 `atlas-ai.service`만 중지하세요. 기존 수집/뉴스/주문/자산은 중지하지 마세요. 중단된 요청은 lease 180초 만료 뒤 failed/unknown으로 정리하고 자동 유료 재실행하지 않습니다.

코드 롤백은 사용자 변경을 보존한 별도 이전 release checkout 또는 정상 revert로 하세요. 롤백 전에 AI 신규 요청을 끄고 실행 중 작업을 정리한 뒤 Node/AI를 재시작하세요. `.venv-lab`, 기존 env/암호화 키, SQLite, Supabase의 기존 구조와 `atlas_ai` 데이터를 보존하고 `DROP SCHEMA CASCADE`를 실행하지 마세요. 이번 SQL의 재실행은 설치 당시 fingerprint와 다르면 안전하게 실패하므로 수동 덮어쓰지 말고 별도 migration으로 처리하세요.

마지막 보고에는 실제 배포 commit, SQL 사전 적용 확인, Node/AI 상태, Vercel deployment, 키 존재/최근 호출 성공, 자료 준비, 유료 호출 수/누적 사용량/unknown, 기존 기능 보존 여부를 각각 구분해 주세요.
