# VPS 헤르메스 전달 절차

TARGET은 사용자가 전달한 `주식 주문 미체결 보완`의 전체 SHA로 고정한다. 현재 origin/main이라고 추정하지 말고 실제 SHA와 커밋 범위를 대조한다. GitHub 푸시·Vercel Production·VPS·SQL 반영은 각각 보고한다.

1. `/opt/atlas`의 atlas 사용자, HEAD/브랜치/clean 여부, 기존 환경·서비스 상태를 값 노출 없이 기록한다. 이전 HEAD를 OLD로 확보한다. `origin/main` fetch 후 TARGET 존재·조상 관계·변경 범위를 확인한다. 작업 트리가 dirty거나 다른 미배포 서버 변경이 있으면 덮어쓰지 않는다.
2. 격리 worktree에서 `npm ci`, `npm run test:server`, `node --test tests/orderManagementProxy.test.js tests/recentOrders.test.js tests/assetSummary.test.js`, `npm run build`. 새 의존성 없음. 운영 venv/AI 설정/키/주문 활성화 플래그를 변경하지 않는다.
3. Supabase SQL Editor 담당자가 **TARGET의 deploy/ORDER_MANAGEMENT_SUPABASE.sql 전문만** 실행하고 마지막 권한 결과 `false,false,true` 및 `false,false,false`를 확인한다. 기존 주문/알림/관심종목/AI SQL 재실행 금지. 새 테이블/RPC 추가이며 기존 데이터는 삭제하지 않는다. 운영 DB에 임의로 테스트 주문 행을 넣지 않는다.
4. 운영자와 주문 변경을 하지 않는 배포 구간을 정하고 진행 중 요청이 없음을 확인한 후 `atlas-api.service`만 정상 중지한다. 활성 요청이 있거나 상태가 불명확하면 강제 종료하지 말고 보류한다. 새 버전은 SIGTERM에서 Fastify 종료 및 진행 중 변경 요청의 결과 기록을 기다린다. pending/uncertain이 발견되면 행을 지우거나 재전송하지 말고 증권사에서 확인한다.
5. 현재 detached 상태는 유지해도 된다. OLD가 TARGET 조상이고 clean일 때 `sudo -u atlas git -C /opt/atlas merge --ff-only "$TARGET"`. 의존성은 잠금파일 변경이 없는지 확인하며 이번 변경만이면 운영 재설치가 필요 없다. `sudo systemctl start atlas-api.service`. AI·평가·알림 worker, DART/일봉 timer, WAL guard, SQLite/WAL/SHM, 환경파일·unit을 변경/재시작하지 않는다.
6. `/api/health` loopback/외부200을 확인한다. 비인증 GET `/api/account/orders/open?broker=kiwoom`과 POST `/api/orders/kiwoom/manage`는401, 별칭 GET/POST `/api/order-management`도401이어야 한다. 키/토큰/계좌/Authorization/요청 본문/증권사 원문을 로그나 보고에 출력하지 않는다. 실주문·정정·취소·카카오·AI 유료 호출로 점검하지 않는다.
7. Vercel은 기존 서버 전용 ATLAS_API_ORIGIN을 재사용한다. Production의 SHA/상태/운영 도메인을 별도로 확인한다. 추가 프록시는 같은 출처 `/api/order-management`만 허용하며 임의 경로·호스트를 받지 않는다. SQL→API→프런트 확인 순서다. 프런트가 먼저 자동 반영돼도 API/SQL 미반영을 빈 목록 성공으로 숨기지 않고 오류/조회 전용으로 표시한다. 이전 화면의 NH 원계좌 입력과 신규 opaque 참조는 새 서버에서 모두 본인 소유를 검증해 호환 처리한다.
8. 허용된 회원은 읽기 전용으로 선택한 개인 증권사·계좌의 미체결을 앱과 대조한다. 전체 종목, 양방향/부분체결, 계좌 전환, 새로고침, 오류/부분 상태, 모바일/테마를 확인한다. 주문 플래그를 임의로 켜지 않는다. NH 정정·취소, 토스 부분체결 정정은 비활성임을 확인한다. 세션이 없으면 미검증으로 보고하며 토큰을 추출하거나 관리자 가장을 하지 않는다.
9. 장애 시 새 변경 요청을 중단하고 진행 중 요청 결과를 확인한다. Vercel을 기록한 이전 정상 Production으로 복구한 뒤 API를 정상 중지하고 `sudo -u atlas git -C /opt/atlas switch --detach "$OLD"`, API만 기동한다. 이전 프런트/서버로 함께 맞추고 브라우저를 새로고침하여 계좌 선택을 다시 한다. 새 SQL 테이블/RPC/요청·접수·불명 이력을 삭제하지 않는다. 이전 서버는 이를 사용하지 않으므로 DB 역마이그레이션 불필요. health/401을 재확인한다. 불명확한 요청을 새 ID로 재전송하거나 잠금을 임의 해제하지 않는다.

공식 명세·지원 제한·수동 실계좌 확인은 OPEN_ORDERS.md에 있다. 현재 단일 API 프로세스의 키움 유량 큐만 구현되어 있으므로 다중 API 인스턴스를 임의로 늘리지 않는다.
