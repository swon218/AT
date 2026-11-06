# 헤르메스 전달문 · 최근 주문

운영 기준 `928b1fd0ef4d00c314b69903cc811699e384a708`의 후속 변경입니다. **`codex/dashboard-orders-only` 브랜치의 `최근 주문` 커밋**만 적용하세요. 사용자가 전달하는 최종 전체 SHA와 이 문서의 마지막 변경 커밋을 대조하세요. `main` pull/merge는 하지 마세요. 취소한 실험실 변경을 다시 적용하지 마세요.

## 이번 변경

- 최근 주문 카드에 키움·토스·NH·KB 다중 선택 버튼이 추가됩니다. 0~4개를 선택하며 마지막 선택도 해제할 수 있습니다. 선택하지 않은 증권사는 조회하지 않습니다.
- **네 곳 모두 등록해야 한다는 이전 조건을 폐기합니다.** 선택한 증권사 중 개인 API가 등록된 곳만 조회합니다. 미등록 증권사는 `unconfigured`로 알리고 다른 선택 증권사 결과를 유지합니다.
- 최근 5거래일 범위에서 선택 증권사 통합 최근 **5건**을 고른 후 오래된 순으로 표시합니다. 가장 최근 주문은 마지막 행입니다. 1개 선택도 같은 표시 규칙을 적용합니다.
- 새로고침 버튼을 없애고 뉴스 카드와 같은 글자 형태의 ‘더보기’를 추가합니다. 아직 연결할 탭이 없으므로 준비 중인 비활성 버튼입니다. 새 탭·라우팅은 만들지 않았습니다.
- 대시보드 진입, 증권사 선택, 계좌 선택, 사용자·개인 키 변경 시 다시 조회합니다. 선택을 모두 해제하면 ‘증권사를 선택해주세요’를 표시하고 이전 행·늦은 응답을 숨깁니다.

## API와 권한

기존 경로를 유지합니다.

```text
GET /api/account/orders/recent?brokers=kiwoom,toss
GET /api/account/orders/recent?brokers=
GET /api/account/orders/recent/:broker/:id
```

- `brokers`는 쉼표로 구분한 증권사 ID입니다. 빈 문자열은 전체 해제입니다. 생략하면 기존 클라이언트 호환을 위해 네 증권사를 선택합니다. 중복 ID는 한 번만 처리하고 알 수 없는 ID는 400으로 거부합니다.
- 목록·상세 모두 매 요청 로그인 세션을 서버에서 확인합니다. 비로그인·만료 세션은 401이며 증권사 호출은 0건입니다.
- 목록은 선택한 각 증권사의 등록 상태와 실제 개인 키 쌍을 서버에서 확인합니다. 미등록·키 삭제 시 그 증권사 조회는 0건이며 `unconfigured` 상태로 반환합니다. 다른 증권사의 미등록은 차단 조건이 아닙니다.
- 상세는 해당 증권사의 개인 키만 요구합니다. 그 증권사가 미등록이면 403과 해당 `missingBrokers`를 반환하고 증권사 호출은 0건입니다. 다른 증권사의 등록 여부는 관계없습니다.
- 선택 전체 해제 또는 선택 증권사가 전부 미등록이면 달력·증권사 조회를 시작하지 않습니다. 이때 `range`는 `null`이고 `items`는 빈 배열입니다. 전체 해제를 ‘최근 주문 없음’으로 표시하지 않습니다.
- 계좌 선택 ID·본인 계좌 대조, 개인 키 전용 조회, no-store, 주문 활성화 스위치와 독립적인 읽기 전용 동작은 유지합니다. API 키·토큰·전체 계좌번호를 출력하지 마세요.

NH는 공식 API에 주문 시각이 없어 같은 날짜 내 정확한 시간순서와 최신 5건 포함 여부를 확정할 수 없습니다. 해당 날짜에서 시각 미제공 주문을 앞에 표시하고 제한 안내를 유지합니다. 토스·NH·KB 개별 체결 목록과 KB 평균체결가의 기존 명세 한계도 그대로입니다.

## 배포·검증

1. 실제 서비스 실행 경로·사용자와 현재 운영 SHA를 확인하고 기존 변경을 보존하세요. 별도 staging checkout에서 진행하며 실패하면 다음 단계는 중단하세요.

   ```bash
   git status --short
   git fetch origin codex/dashboard-orders-only
   # DEPLOY_SHA에는 사용자가 전달한 이번 '최근 주문' 전체 SHA를 설정
   git switch --detach "$DEPLOY_SHA"
   git merge-base --is-ancestor 928b1fd0ef4d00c314b69903cc811699e384a708 HEAD
   git log -1 --format='%H %s' -- deploy/RECENT_ORDERS_SELECTION_HERMES.md
   git diff --name-only 928b1fd0ef4d00c314b69903cc811699e384a708 HEAD
   node --test server/recentOrders.test.js tests/recentOrders.test.js tests/assetSummary.test.js
   npm run test:server
   npm run build
   ```

2. 변경 목록에 `lab/`, 실험실 UI, DB, 수집 unit/timer가 포함되면 중단하세요. 이번에는 Python 코드 변경이 없으므로 `atlas-ai` 재시작이나 운영 venv에 pytest 설치는 필요하지 않습니다. 새 환경변수·DB 변경·의존성 추가도 없습니다.
3. 기존 배포 방식으로 같은 SHA의 Node 코드를 반영하고 `atlas-api`만 재시작하세요. 실제 포트를 확인한 뒤 비로그인 목록·상세 401을 확인하세요.
4. Vercel은 **동일한 선별 브랜치의 최종 SHA**로 Production 배포하세요. `main`의 최신 배포를 승격하지 마세요. 기존 `VITE_API_BASE_URL`과 서버 설정을 유지하세요.
5. 실제 웹에서 전체 해제, 1·2·3·4개 선택, 미등록 KB를 제외한 다른 증권사 조회, 미등록을 함께 선택한 부분 결과, NH 계좌 선택을 확인하세요. 통합 결과가 최대 5행이고 주문 날짜·시각이 위에서 아래로 증가하는지 확인하세요. 가장 최근 거래가 마지막 행이어야 합니다.
6. 새로고침 버튼이 없고 ‘더보기’ 준비 중 버튼만 있는지, 새 주문내역 탭을 만들지 않았는지 확인하세요. 사용자 전환·로그아웃·키 변경·선택 해제 시 이전 행이 남지 않아야 합니다. 실주문은 보내지 마세요.
7. 브라우저의 `Failed to fetch`나 `LocalNetworkAccessPermissionDenied`가 보이면 미등록이나 빈 주문으로 판정하지 마세요. 기존 Chrome Local Network Access/DNS 경로 문제와 구분해서 보고하세요. 브라우저 보안 검사를 끄는 방식으로 검증을 통과시키지 마세요.

모의 브라우저 재현: `node tests/recentOrdersBrowserHarness.mjs` → `http://127.0.0.1:15176/tests/recentOrders.html`. 모의 결과와 실계좌 대조를 구분해 최종 SHA, VPS 상태, Vercel Production 여부, 실제 조회 결과를 사용자에게 보고하세요. 문서 작성·푸시만으로 운영 배포 완료라고 보고하지 마세요.
