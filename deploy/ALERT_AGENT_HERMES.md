# ATLAS 알림 에이전트 운영 반영

대상은 전달받은 `main`의 전체 SHA입니다. 기존 운영은 `/opt/atlas`의 `atlas` 체크아웃, `/etc/atlas/atlas.env`를 쓰는 `atlas-api.service`, `/etc/atlas/ai.env`를 쓰는 `atlas-ai.service`, `main` 연동 Vercel Production입니다.

## 1. 선행 확인과 SQL

- 운영 HEAD, 워크트리 상태, `origin/main`, 이전 Vercel Production SHA·배포 ID를 기록합니다. `git fetch origin main` 후 전달 SHA가 원격 `main`에 있고 운영 HEAD의 후속인지 확인합니다. 워크트리가 변경됐거나 서버 실행 diff에 다른 미승인 작업이 있으면 반영을 멈춥니다.
- ATLAS 인증용 Supabase에 기존 `WATCHLIST_SUPABASE.sql`, `KAKAO_CONNECTION_SUPABASE.sql` 구조가 있는지 확인합니다. 사용자가 대상 SHA의 `deploy/ALERT_AGENT_SUPABASE.sql` 전체를 SQL Editor에서 먼저 실행하고 마지막 두 쿼리 결과를 확인합니다. 테이블 네 개의 RLS는 모두 `true`, 브라우저·서버 역할의 직접 권한은 모두 `false`, RPC 실행 권한은 `anon=false`, `authenticated=false`, `service_role=true`여야 합니다.
- SQL은 재실행할 수 있습니다. 운영 SQL·회원 규칙·이력은 백업 및 복구 중에도 삭제하지 않습니다. 기존 관심종목 및 카카오 연결에는 트리거만 추가합니다. 발송 요청이 진행 중이면 관련 중지·삭제·연결 해제는 짧게 거부되며 발송 요청이 종료된 후 다시 시도할 수 있습니다.

## 2. 감시를 끈 상태에서 코드 반영

- 환경파일이 변경될 경우 기존 모드·소유자를 보존하고, 변경 전 백업은 root 전용 `0600`으로 저장합니다. `/etc/atlas/atlas.env`에서 `ATLAS_ALERT_CONSENT_ENABLED=false`, `ATLAS_ALERT_WORKER_ENABLED=false`, `ATLAS_ALERT_MARKET_APPROVED=false`, `ATLAS_ALERT_KAKAO_APPROVED=false`를 유지합니다. 기존 Supabase·카카오·암호화·`FRONTEND_ORIGIN`·AI 내부 인증 설정을 그대로 사용합니다. 새 키는 이 단계에서 필요하지 않습니다.
- 격리된 worktree와 테스트 venv에서 `node --test server/alertAgent.test.js server/kakaoConnection.test.js server/agent.test.js`와 `python -m pytest ai_agent/tests/test_alert_tools.py ai_agent/tests/test_order_calendar.py -q`를 실행합니다. 운영 venv에 검증용 패키지를 추가하지 않습니다.
- SQL 확인 후 운영 체크아웃에서 승인 SHA로 `git merge --ff-only <전달 SHA>`를 실행합니다. `atlas-ai.service`를 먼저 재시작해 `127.0.0.1:8010`에서 준비를 확인한 뒤 `atlas-api.service`를 재시작합니다. 기존 Vercel 자동 배포가 먼저 도착하면 기존 분석은 호환되며 알림 설정은 API 반영 전까지 일시적으로 불가할 수 있습니다. Vercel에서 같은 SHA의 `Production / Ready` 및 운영 도메인 반영을 따로 확인합니다.
- `atlas-alert-worker.service`를 설치할 경우 저장소 파일 그대로 설치하고 `systemd-analyze verify`, `daemon-reload`를 실행합니다. 서비스는 비활성 상태로 둡니다. 같은 사용자·작업 경로·환경파일에서 `node server/alertWorker.js`를 한 번 실행하면 `disabled`만 반환해야 합니다. 수동 실행 시에도 비밀값을 인자로 넣거나 환경파일을 출력하지 않습니다.

## 3. 운영 검증과 활성화 조건

- API health의 loopback·외부 `200`, 비인증 `GET` 및 `POST /api/agent/alerts`의 `401`, Python 내부 달력의 비인증 거부를 확인합니다. 사용자에게 허용된 브라우저 세션에서 분석 대화, 알림 초안·같은 작은 대화방, 감시 준비 중, 비활성 매매 버튼, 기존 관심종목 및 카카오 계정 연결을 확인합니다. 운영 데이터·실계정 토큰·응답 원문을 출력하지 않습니다. 검증을 위해 주문이나 실제 메시지를 보내지 않습니다.
- 키움에는 운영자 전용 키로 다수 회원의 KRX 시세를 상시 조회해 서버 조건을 계산하고, 가격·등락률을 카카오 자기 채팅에 전달·이력에 저장할 수 있는지와 호출/IP/재배포 조건을 확인합니다. 승인 후 해당 키만 `ATLAS_ALERT_KIWOOM_APP_KEY`, `ATLAS_ALERT_KIWOOM_SECRET_KEY`로 Node 환경파일에 저장합니다. 회원 개인 키는 공유하지 않습니다. `ka10079` 응답의 KRX 전용 코드, 체결일·시각·가격·전일 대비를 읽기 전용으로 대조하고, 특별 장 운영시간과 `AI_CALENDAR_THROUGH`의 검토 범위를 확인합니다.
- 카카오에는 다수 회원이 개별 동의한 뒤 서버가 KRX 조건 충족 시 각 회원의 자기 채팅으로 자동 전송하는 용도의 허용 여부, 앱 상태·사업자 또는 별도 심사 요건, 사용자·앱 쿼터를 확인합니다. 승인된 앱의 동의항목에 `talk_message`를 선택 동의로 설정하고, 제품 링크 관리의 웹 도메인에 `https://at-chi-six.vercel.app`을 등록합니다. 기존 Redirect URI는 유지합니다. 사용자가 개인설정에서 카카오 연결 후 **메시지 전송 동의**를 직접 완료해야 합니다.
- 두 공급자의 사용 허용과 운영자 승인을 확보한 다음, 적용 가능한 가장 낮은 일일 요청 한도를 `ATLAS_ALERT_DAILY_LIMIT`로 설정합니다. 초기 기본은 앱 전체 50건/한국시간 일이며 각 발송 시도도 포함합니다. `ATLAS_ALERT_CONSENT_ENABLED`, `ATLAS_ALERT_MARKET_APPROVED`, `ATLAS_ALERT_KAKAO_APPROVED`, `ATLAS_ALERT_WORKER_ENABLED`를 승인 범위에 맞춰 켜고 Node를 재시작한 후 `atlas-alert-worker.service`를 `enable --now` 합니다. 별도로 허가한 테스트 회원과 합의한 경우에만 정규장 내 한 번의 실발송을 확인합니다.
- 워커는 앞선 실행이 끝난 뒤 약 60초 간격으로 동작합니다. 한 주기에 최대 10종목을 1초 이상 간격으로 조회하고 키움 토큰은 프로세스 메모리에서 재사용합니다. 데이터가 많으면 종목별 재확인 간격이 길어질 수 있습니다. 시세가 90초보다 오래됐거나 시장·세션을 확인하지 못하면 조건을 평가하지 않습니다. 규칙 버전당 한 번만 관측 이벤트를 만들고, 응답이 유실되면 확인 불가로 남깁니다. 카카오에서 확인된 일시적인 제한 거절만 60초 이후 최대 한 번 다시 시도합니다. 완료된 이력과 사용이 끝난 규칙은 워커 실행 시 90일 후 정리됩니다.

## 4. 실패 시 복구

- 먼저 `sudo systemctl disable --now atlas-alert-worker.service`를 실행하고 `ATLAS_ALERT_WORKER_ENABLED=false`로 되돌립니다. 이미 전송을 요청한 기록은 확인 불가일 수 있으므로 운영자가 재전송하지 않습니다. 동의까지 중단할 경우 `ATLAS_ALERT_CONSENT_ENABLED=false`도 적용합니다.
- 이전에 기록한 정상 SHA와 환경 설정을 복원하고 AI·Node만 이전 버전으로 재시작한 뒤 health·비인증 차단·기존 카카오 연결을 확인합니다. 프런트 롤백이 필요하면 기록한 Vercel Production 배포를 복구합니다. SQL·회원 데이터는 남겨둡니다. 실험실 DB, 수집·DART 타이머, 수동 주문 설정, AI 모델·키는 건드리지 않습니다.
- Supabase 적용, VPS SHA·서비스, Vercel Production SHA·배포 ID, 동의 활성화, 워커 활성화, 실제 카카오 전송 검증을 각각 보고합니다. 키·토큰·회원 식별자·환경파일 본문은 보고에 포함하지 않습니다.

[키움 틱차트 공식 예제](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/main/examples/국내주식/차트/get_domestic_stock_tick_chart.py) · [카카오 나에게 보내기](https://developers.kakao.com/docs/ko/kakaotalk-message/rest-api#send-me) · [기본 메시지 템플릿](https://developers.kakao.com/docs/ko/message-template/default) · [카카오 쿼터](https://developers.kakao.com/docs/ko/getting-started/quota)
