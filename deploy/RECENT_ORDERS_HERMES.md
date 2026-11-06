# 헤르메스 전달문 · 대시보드 주문내역

이번 배포는 운영 기준 `6cdeb74b572254de7646d636a6275e4430086f16`에서 분리한 **`codex/dashboard-orders-only` 브랜치**만 사용하세요. `main`을 운영에 pull/merge하지 마세요. 이 브랜치에는 대시보드 보유종목 추가·수정과 주문내역 변경만 포함되어 있습니다. 사용자가 전달한 최종 SHA와 `git log -1 --format='%H %s' -- deploy/RECENT_ORDERS_HERMES.md`를 대조하세요. 이 문서는 배포 완료 보고가 아닙니다. 실주문을 보내거나 주문 활성화 스위치를 변경하지 마세요.

## 취소한 실험실 작업과 테스트 환경

- `118aa19`와 `ac85f2a`의 실험실 일봉 전환은 이번 배포에서 제외합니다. 기존 운영 실험실 코드·DB·수집 정책·unit·timer를 그대로 유지하세요. 실패한 전환 게이트를 이번 작업으로 해결하거나 우회하지 마세요.
- 운영 `.venv-ai`에는 pytest를 설치하지 마세요. 같은 선별 배포 SHA에서 격리된 테스트 전용 venv로 실행한 달력 테스트 통과 결과를 인정합니다. 테스트 venv의 Python과 운영 Python/런타임 의존성 버전을 대조하고, 운영 venv에서는 pytest 없이 달력 함수와 내부 HTTP 경로를 읽기 전용으로 확인하세요.
- 새 Git SHA가 생기는 선별 배포입니다. 원본 `c447396`은 변경의 출처이며 최종 배포 SHA는 사용자가 별도로 전달한 **이 브랜치의 최종 SHA**입니다. 다른 변경을 섞지 말고 해당 SHA를 고정해 배포하세요.
- 선별 브랜치 로컬 재검증: Node 서버 110/110, 프런트 유틸·자산 집계 7/7, Python 달력 22/22, 웹 빌드 통과. 원래 main의 서버 113개에서 취소한 실험실 변경의 테스트 3개가 빠져 110개가 된 것입니다.

## 배포 범위

- Node `atlas-api`에 개인 주문내역 목록·상세 API가 추가됩니다.
- Python `atlas-ai`에 모델과 독립적인 내부 거래일 달력 경로가 추가됩니다. 기존 XKRX 달력과 검토된 휴장 보정을 그대로 사용합니다. OpenAI 키·유료 호출이 필요하지 않습니다.
- Vercel 프런트엔드에 같은 커밋의 카드가 필요합니다. 기존 `VITE_API_BASE_URL`을 유지합니다.
- 새 환경변수, npm/Python 의존성, DB 테이블·SQL 마이그레이션은 없습니다.
- 기존 `AI_INTERNAL_URL`, `AI_INTERNAL_SECRET`이 Node와 Python 사이에 일치해야 합니다. `KB_CLIENT_IP`, `KB_CLIENT_MAC`은 기존 KB 클라이언트의 필수 설정이며 이번에 새로 추가한 변수가 아닙니다. 키·토큰·전체 계좌번호·환경파일 내용은 출력하지 마세요.

## 최종 경로와 접근 조건

| 용도 | 경로 |
| --- | --- |
| 목록 | `GET /api/account/orders/recent` |
| 펼친 행 상세 | `GET /api/account/orders/recent/:broker/:id` |
| 내부 달력 | `GET /calendar/order-days?date=YYYY-MM-DD` (Python loopback, `X-Atlas-Internal` 필수) |

목록과 상세는 매번 Supabase 로그인 검증 및 해당 사용자의 복호화된 네 증권사 필수 키와 등록 상태를 확인합니다. 비로그인/만료 세션은 401, 일부 미등록은 403(`missingBrokers`)이며, 이 단계에서 증권사 호출은 0건입니다. 개인 키 인증 오류에 관리자 키를 쓰지 않습니다. 개인 응답에 `Cache-Control: private, no-store`와 `Pragma: no-cache`가 적용됩니다. 목록·상세·계좌 응답을 공유 캐시에 보관하지 않습니다. 인증 토큰의 기존 서버 내부 캐시와 공개 거래일 달력은 이와 별개입니다.

쿼리 선택자는 `kiwoomAccount`, `tossAccount`, `nhAccount`, `kbAccount`이며 API가 반환한 불투명 계좌 선택 ID만 사용합니다. NH는 매번 본인 API의 계좌 목록과 대조합니다. 전체 계좌번호를 브라우저에 보내지 않습니다. 여러 NH 계좌면 기존 규칙대로 명시적으로 선택하기 전 NH 주문을 읽지 않습니다. 키움·KB는 개인 키에 연결된 계좌, 토스는 기존 종합매매 우선 선택 규칙을 사용합니다.

목록의 `brokers`는 `ready`, `accountRequired`, `error`를 구분합니다. 개별 키 만료·권한 거절·페이지 누락·25초 제한은 해당 증권사 실패로 표시합니다. 전체가 `ready`이면서 모두 빈 결과인 경우에만 화면에 ‘최근 주문 없음’이 나옵니다. 상세도 동일한 접근 조건을 검사하고 현재 5거래일·본인 조회 계좌에서만 찾습니다.

## 증권사별 공식 확인 범위와 한계

| 증권사 | 구현 조회 | 공식 확인 내용 | 실계좌 대조 |
| --- | --- | --- | --- |
| 키움 | `POST /api/dostk/acnt`, `kt00007` + `kt00009` | 주문일별 전체 주식, 모든 거래소 `%`, `cont-yn`/`next-key`; `kt00009`의 체결번호·시각·수량·단가로 중복 제거 및 실제 체결 가중평균 | 미실시 |
| 토스 | `GET /api/v1/accounts`, `GET /api/v1/orders`의 `OPEN` + `CLOSED` | KST `from/to`, CLOSED 최대 100건 및 cursor/hasNext, OPEN 전량; 실제 주문 상태와 execution 집계 사용 | 미실시 |
| NH | `POST /n2/acctinfo`, `POST /krstock/inquiry/v1/dailyOrderExecution` | `orr_dt`별 5회, `ost_cns_dit=0`, 본인 계좌, cts 연속조회, 누적 체결수량·평균단가·체결금액·취소수량 | 미실시 |
| KB | `POST /api/v1/ssqm2341` | 공식 B2C 상세 JSON의 `ccls_clsf=0`, `ordr_dt`, `nxt_key`, `Record1`과 dataHeader/dataBody 샘플 구조 | 미실시 |

**확정할 수 없는 정보를 생성하지 않습니다.**

- NH 공개 명세에는 주문 시각·개별 체결 목록이 없습니다. 날짜와 주문 집계만 표시하며 시각은 ‘—’입니다. 날짜 내 시각 확인 주문 뒤에 배치하고 **정확한 통합 최신 10건의 순서를 보장할 수 없다는 안내**를 표시합니다. 이를 완전히 해결하려면 NH의 주문시각 필드가 포함된 공식 추가 명세가 필요합니다.
- 토스는 개별 체결 목록 대신 누적 수량·평균가·최종 체결 시각만 제공합니다. `CLOSED`를 일괄 체결 완료로 바꾸지 않습니다. Open API가 지원하지 않는 호가 유형의 외부 주문은 공식 API 자체가 반환하지 않습니다.
- KB `ccls_uprc`는 ‘체결단가’이며 주문별 평균가로 명시되어 있지 않습니다. 주문별 실제 체결금액도 없어 평균체결가는 ‘—’입니다. 개별 체결 시각·목록도 제공되지 않습니다. 해당 추가 공식 명세를 확보하기 전에는 단일 체결단가를 평균가로 표시하지 않습니다.
- KB 정정취소 구분 필드의 숫자 열거값은 공개 상세 JSON에 없습니다. 추정 매핑은 하지 않으며 명시적 취소 이름 또는 확인된 취소수량으로만 취소를 판정합니다. 나머지 불명 상태는 ‘상태 확인 필요’입니다. 특히 비-SOR 취소 코드의 의미는 추가 공식 코드표·실계좌 대조가 필요합니다.
- 키움·NH·KB는 일자별 조회 필드가 있지만, 확보한 문서에는 최대 보관기간의 확정 수치가 없습니다. 최근 5거래일 각 날짜만 요청하고 거절되면 부분 실패로 처리합니다. 토스의 from/to도 문서에 별도 최대 보관기간이 명시되어 있지 않습니다.
- 테스트는 토스의 공식 예제 구조, NH의 공식 스키마, KB의 공식 플레이스홀더 샘플과 필드표, 키움의 공식 필드표를 사용한 모의 응답입니다. 실계좌 성공 증거로 표현하지 마세요.

공식 출처:

- [키움 kt00007](https://openapi.kiwoom.com/m/guide/apiguide/08/kt00007), [kt00009](https://openapi.kiwoom.com/m/guide/apiguide/08/kt00009)
- [토스 OpenAPI](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)
- [NH 국내주식 OpenAPI](https://www.nhplug.com/openapi-docs/krstock/openapi.json)
- [KB B2C 문서](https://openapi.kbsec.com/apidoc_b2c), [SSQM2341 공식 상세 JSON](https://openapi.kbsec.com/api/apis/catalog/66998ea3-85f3-4060-bf6d-f88a163eee35/tr-list)

## 적용과 검증

1. 먼저 실제 서비스 경로·실행 사용자·환경파일 경로를 확인하세요. 아래 이름과 경로는 기존 운영 기준이며 현장 확인 후 사용하세요.

   ```bash
   systemctl show atlas-api.service atlas-ai.service -p WorkingDirectory -p User -p EnvironmentFiles
   ```

2. 저장소 소유자로 작업하고 기존 변경을 보존하세요. 운영 checkout에 `git pull origin main`을 하지 마세요. 별도 staging checkout에서 아래 브랜치를 fetch한 뒤 사용자가 전달한 최종 SHA에 고정하세요. 실패하면 다음 단계는 중단하세요.

   ```bash
   git status --short
   git fetch origin codex/dashboard-orders-only
   # DEPLOY_SHA에는 사용자가 승인한 이번 선별 배포의 최종 전체 SHA만 입력
   git switch --detach "$DEPLOY_SHA"
   git merge-base --is-ancestor 6cdeb74b572254de7646d636a6275e4430086f16 HEAD
   git diff --name-only 6cdeb74b572254de7646d636a6275e4430086f16 HEAD
   git log -1 --format='%H %s' -- deploy/RECENT_ORDERS_HERMES.md
   node --test server/recentOrders.test.js tests/recentOrders.test.js
   npm run test:server
   "$TEST_VENV/bin/python" -m pytest ai_agent/tests/test_order_calendar.py ai_agent/tests/test_calendar_screener.py -q
   npm run build
   ```

변경 목록에 `lab/`, `ai_agent/screener.py`, `ai_agent/screen_engine.py`, `ai_agent/tools.py`, 실험실 UI, 수집 unit/timer 또는 실험실 SQL이 있으면 중단하세요. `ai_agent/app.py`는 주문 달력 내부 경로 추가만, `ai_agent/market.py`는 최근 5거래일 함수 추가만 있어야 합니다. 운영 기준에서 실험실 관련 경로의 diff가 비어 있는 것을 확인한 후 기존 배포 방식으로 선별 checkout을 운영에 반영하세요. 운영 DB 전환과 마이그레이션은 실행하지 마세요.

3. 기존 AI_INTERNAL_SECRET의 일치와 Python의 달력 검증 범위를 확인하세요. 현재 기본 `AI_CALENDAR_THROUGH`는 2026-12-31입니다. 범위를 벗어나면 503으로 실패하며 임의 평일 달력으로 대체하지 않습니다. 연장에는 기존 휴장일 검토 절차가 필요합니다.

   ```bash
   sudo systemctl restart atlas-ai.service
   sudo systemctl restart atlas-api.service
   systemctl is-active atlas-ai.service atlas-api.service
   curl -sS -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:3000/api/account/orders/recent
   ```

   비로그인 목록 응답은 401이어야 합니다. 상세의 임의 형식 유효 id도 인증 전에는 401이어야 합니다. 내부 달력은 헤더 없이 401, 운영 서비스 환경에서 기존 내부 헤더로 요청하면 최근 5거래일을 반환해야 합니다. 비밀값을 명령행 인자나 로그에 출력하지 마세요.

4. `main`이 아닌 **선별 브랜치의 같은 최종 SHA**로 Vercel Production/Ready 배포를 확인하세요. 최신 main 배포를 승격하지 마세요. 실제 웹에서 비로그인, 일부 미등록의 누락 증권사명·개인 설정 동작, 네 곳 등록 사용자의 네 증권사 조회, NH 계좌 선택을 확인하세요. 실제 대조를 허용한 사용자 계좌의 최근 5거래일 주문을 각 증권사 앱과 비교하세요. ATLAS 밖에서 낸 주문도 API가 반환하면 포함되어야 합니다. 실주문 테스트를 보내지 마세요.
5. 한 곳 실패 때 나머지 결과 유지, 전부 정상 0건, 부분체결·잔량취소·전량취소·거절·체결 완료, 행 펼침, 수동 갱신과 주문 화면에서 대시보드 복귀를 확인하세요. 로그아웃·사용자 전환·키 변경/삭제·NH 계좌 변경 시 이전 행과 늦은 상세 응답이 표시되지 않아야 합니다.
6. 증권사별 상태와 API/웹의 배포 SHA, 내부 달력 상태, 실계좌 대조 여부와 명세상 한계를 분리하여 사용자에게 보고하세요. 키·토큰·전체 계좌번호·원본 개인 응답은 보고에 포함하지 마세요.

브라우저 모의 재현은 `node tests/recentOrdersBrowserHarness.mjs` 실행 후 `http://127.0.0.1:15176/tests/recentOrders.html`에서 가능합니다. 실제 인증·달력·증권사 호출이 주입된 모의 동작이며 운영용 실행기가 아닙니다.
