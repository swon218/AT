# 주식주문 개인 평균 매입가 표시 반영

대상은 `주식주문 매수 타이밍 버튼` 커밋의 전달받은 전체 SHA입니다. 프런트는 GitHub main 연동 Vercel, 서버는 `/opt/atlas`의 기존 `atlas-api.service`를 사용합니다. 이번 작업의 SQL·의존성·환경변수·unit 변경은 없습니다.

## 변경 범위와 데이터

- 기존 개인 `/api/account/{kiwoom|toss|nh|kb}/summary` 한 번의 응답을 주문 폼과 가격선이 공유합니다. 새 endpoint나 저장 테이블은 없습니다.
- 키움 `kt00018`의 `rmnd_qty/pur_pric`, 토스 holdings의 `quantity/averagePurchasePrice`, NH balance의 `itg_bnc_qty/phs_pr`, KB `ssqm2952`의 `byng_avr_prc`를 사용하며, 매입가 표시용 수량은 `hld_q`(보유수량)와 `ec_q`(정산수량)가 일치하고 `nstmt_b_q/nstmt_s_q`가 모두 명시적 0일 때만 확정합니다. 기존 자산·주문의 `quantity`는 바꾸지 않습니다. NH는 본인에게 귀속된 선택 계좌의 opaque ref를 기존 경로로 검증합니다.
- 수량·평균가 누락을 0으로 채우지 않고, 조회 실패·미완료를 미보유로 표시하지 않습니다. 키움은 최대 50페이지를 기존 유량 제어로 직렬 연속조회합니다. 네 증권사 summary는 공유 20초 deadline, 브라우저 읽기는 25초 한도입니다.
- 키움/토스는 현재 종목의 양수 보유 행이 정확히 하나일 때 표시합니다. 수량 불명 또는 복수 양수 행은 임의 합산하지 않습니다. NH/KB는 기존 현금 보유 조회 범위를 유지합니다. KB 미결제·수량 불일치·필수 수량 누락은 별도 안내와 함께 표시하지 않습니다.
- 기본 해제이며 회원·증권사·계좌·종목·자격증명 변경과 주문 화면 재진입 시 해제됩니다. 표시 중인 화면에서만 30초 신선도 갱신을 적용하고 실패하면 선을 숨깁니다. 주문 접수 직후에는 기존 계좌 갱신을 사용하며 전량 매도 확인 전에 보유량을 추정하지 않습니다.
- 주문·정정·취소·권한·AI·수집 경로는 바꾸지 않습니다. 차트의 운영자/대체 시세와 개인 평균 매입가는 별개입니다.

## 반영 절차

1. `/opt/atlas`의 OLD SHA, clean 상태, 실제 API unit의 User/WorkingDirectory/ExecStart/환경파일 및 기존 서비스 상태를 기록합니다. `git fetch origin main` 후 TARGET이 main에 포함되고 OLD의 후속인지 확인합니다. 로컬 변경은 덮어쓰지 않습니다. OLD..TARGET의 전체 변경을 확인하고 선행 미배포 기능이 있다면 그 지침도 따릅니다. 특히 선행 관리자 평가 삭제 커밋의 SQL 적용은 이번 기능의 SQL과 별개입니다.
2. TARGET 격리 worktree에서 `npm ci`와 아래 모의 검사를 실행합니다. 운영 의존성을 업그레이드하거나 환경파일을 출력하지 않습니다.

```sh
node --test --test-concurrency=1 server/accountHoldings.test.js server/addedBrokers.test.js server/kiwoomClient.test.js server/accountConnections.test.js server/accountSettings.test.js server/recentOrders.test.js server/orderReadCoordinator.test.js server/openOrders.test.js tests/recentOrders.test.js tests/assetSummary.test.js tests/purchasePrice.test.js tests/purchasePriceLine.test.js tests/purchasePriceAccountApi.test.js tests/chartTime.test.js tests/chartCandles.test.js tests/strategies.test.js tests/strategyDraft.test.js tests/theme.test.js
npm run build
```

3. API의 진행 중 요청과 연결이 정리되기를 기다린 뒤 `atlas-api.service`만 정상 중지합니다. clean checkout에서 `git merge --ff-only "$TARGET"`로 반영한 뒤 API만 기동합니다. unit 변경이 없으므로 daemon-reload는 필요 없습니다. AI·평가·알림 worker·일봉/DART timer·WAL guard·운영 DB는 변경하거나 중단하지 않습니다.
4. readiness 재시도로 loopback/기존 외부 `/api/health=200`을 확인합니다. 네 증권사의 `/api/account/<broker>/summary?symbol=005930` 비인증 접근은 401이어야 합니다. 실제 주문/취소 경로는 호출하지 않습니다. 신규 5xx·uncaught 오류가 없는지 확인하되 키·토큰·계좌번호·보유 응답 원문은 출력하지 않습니다.
5. Vercel Production의 TARGET SHA/배포 ID/상태와 운영 도메인 `https://at-chi-six.vercel.app`을 확인합니다. 프런트가 먼저 배포되어도 기존 주문 화면은 유지되지만, 엄격한 보유정보 검증과 연속조회 반영은 서버 배포 후 확인합니다. 구 키움 summary의 broker 필드 누락은 인증된 키움 endpoint의 출처 메타데이터로 호환하며 다른 명시적 증권사를 덮어쓰지 않습니다.
6. 허용된 회원 세션이 있을 때만 읽기 전용으로 기본 해제→선택 증권사·본인 계좌의 현재 종목 평균 매입가 표시/숨김, 계좌 변경·로그아웃 시 제거, 주기·테마 유지와 평균가 위치 보기를 확인합니다. 실계좌 키가 없거나 세션이 없으면 미검증으로 보고합니다. 토큰 추출이나 회원 가장은 하지 않습니다. 키 삭제·실제 매수·매도·정정·취소·카카오·유료 AI를 검증 목적으로 실행하지 않습니다.

## 복구

- 장애가 있으면 API만 정상 중지하고 기록한 OLD로 기존 운영 방식에 맞춰 checkout한 뒤 API만 기동합니다. 강제 reset/push를 하지 않습니다.
- 필요하면 Vercel을 기록한 직전 정상 Production으로 복구합니다. SQL·회원 키·계좌·일봉 DB·환경파일을 변경하거나 복원할 필요가 없습니다. 선행 기능에 별도 SQL이 적용되어 있다면 그 마이그레이션은 보존합니다.
- health/비인증 401과 무관한 서비스 보존을 다시 확인합니다. 보고에는 OLD/TARGET, 테스트, 프런트/VPS 상태, 실제 계좌 검증 여부, 실주문 없음과 미검증 항목을 구분합니다.
