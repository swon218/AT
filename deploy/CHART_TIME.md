# 차트 시간 계약과 제공 범위 (2026-11-14)

## 원인과 표시

기존 키움 `+09:00` 문자열 → Unix 초 변환은 실제 시각을 나타냈지만,
Lightweight Charts 5.2.0의 기본 UTC 눈금과 기본 `dd MMM 'yy` 교차선 형식을 사용했다.
로컬의 같은 09:00 KST 모의 봉에서 기존 `13 11월 '26 00:00`과 수정 후
`26년11월13일 09:00`을 실제 캔버스로 비교했다.

- 서버 HTTP 분봉 `items[].time`: 실제 UTC Unix **초**. 화면용 9시간 가산을 하지 않는다.
- 일·주·월: `YYYY-MM-DD` 거래일 문자열. 시각을 만들지 않는다.
- 프런트 공통 파서는 초/밀리초와 명시적 ISO 오프셋을 구분한다. 시간대 없는 문자열은
  공급자 어댑터가 명시적으로 KST로 해석할 때만 허용한다. 잘못된 날짜/시각은 제외한다.
- 교차선 `localization.timeFormatter`: `YY년MM월DD일 HH:mm`, 날짜 봉은 날짜만.
- 눈금 `timeScale.tickMarkFormatter`: KST 시·분, 날짜/월/연도 경계의 짧은 날짜.
  라이브러리의 눈금 가중치 선택은 유지한다. 캔들·거래량·지표·마커의 시간은 동일하다.
- `sourceBroker`와 메타데이터는 표시 정보뿐이며 인증·주문 세션·권한을 바꾸지 않는다.

## 증권사별 근거와 구현

| 증권사 | 분봉/시간 계약 | 거래소·시간외 | 기간/개수/연속조회 |
| --- | --- | --- | --- |
| 키움 | `ka10080`, `cntr_tm=YYYYMMDDHHmmss` KST **봉 시작**, 1/5/10/15/30/60 직접 요청 | `stk_cd`: KRX 기본, NXT `_NX`, 통합 `_AL`. 주문 화면 분봉은 통합 요청. 반환된 시간외 봉을 필터로 버리지 않음. 공식 가이드만으로 모든 종목의 08~20시 제공은 확정 못함 | 요청 최대 500봉, 화면 200봉. `cont-yn/next-key` 최대 3페이지·20초. 키움 공통 읽기 제한 5 TPS 재사용. 뒤 페이지 실패는 전체 실패·캐시 미저장 |
| 토스 | 공식 `1m`/`1d`, 오프셋 있는 ISO `timestamp`. 1m는 **봉 종료**. 5/10/15/30/60은 실제 1m로 합성 | Candle 요청에 거래소·세션 선택 인자 없음. 앱의 08:30~20:00과 같다고 확정하지 않음. 제공된 구간만 표시 | 원본 1페이지 최대 200, `nextBefore`/inclusive `before` 중복 제거. 최대 15페이지·3,000원본봉·20초. 차트 전용 20 TPS 기준 자격증명별 50ms 간격, 429 Retry-After 우선. 뒤 페이지 실패/한도는 부분 조회 |
| NH | `/krstock/quote/v1/period`, 날짜+HHmmss를 KST 해석. 시작/종료 의미는 명세에서 미확인. `gubun=5`, `xtick`으로 6주기 직접 요청 | `market_cd=KRX/NXT/UNT`, `view_main_yn=N` 전체 / `Y` 정규장. 주문 화면 분봉 `UNT+N`. NXT 대상 종목·실제 거래일의 공급자 반환 구간만 표시 | 현재가 응답으로 종목 시장 확인 후 기간봉 요청. 광고된 `cts`만 최대 10페이지·20초. 요청 최대 500봉, 화면 200봉. 뒤 페이지 실패는 부분 조회 |
| KB | `IVS11560`, `dt+tm` KST. 시작/종료 미확인. `chrt_clsf=B`, `minute_tck_indx`으로 6주기 직접 요청 | 차트 명세에서 KRX/NXT 선택·시간외·연속조회 인자 미확인. 현재가 `IVU10140`의 거래소 인자를 차트에 임의 적용하지 않음. 별도 시간외 의도는 400으로 거절 | 개수 조회, 최대 500 요청·화면 200, 1페이지·20초. `strt_dy`는 시작일이므로 최근 개수 조회에 오늘을 잘못 넣지 않음. 기존 운영자 KB 미설정 시 키움 대체는 실제 제공 증권사/거래소를 명시. 개인 KB 오류는 대체하지 않음 |

직접 API 수신 검증은 **네 증권사 모두 미실행**이다. 표의 제공 범위는 공식 명세와
모의 응답 테스트 기준이며 가입 상품·과거 보존기간·실제 NXT 대상별 수신은 별도 운영 읽기 확인이 필요하다.
키움/NH/KB의 공식 문서에서 확인하지 못한 정확한 과거 보존기간·페이지당 상한을 임의로 보장하지 않는다.

토스 합성은 1m의 개념적 시작(`종료−60초`)을 KST 시계 구간으로 묶고 실제 마지막 종료 시각을 유지한다.
시간순 첫 시가/최대 고가/최소 저가/마지막 종가/거래량 합계이며, 거래일·결측 간격·명시적 세션 변경을 나눈다.
거래량 일부가 없으면 합계도 `null`이다. 왼쪽 미완성 구간은 제외하고 부분 조회로 표시한다.
공식 Candle에는 세션/거래소 필드가 보장되지 않아 **연속된 무표식 세션 전환은 식별할 수 없다**.
공식 다분봉 또는 공식 통합 거래소 봉과 같은 구간 기준이라고 주장하지 않는다.

모든 차트는 **최근 최대 N개**이고 `fullDay=false`다. 200개를 하루 전체라고 하지 않으며
부족한 개수를 가짜 봉으로 채우지 않는다. 이번 변경에 별도 하루 전체 모드/무제한 과거 로딩은 없다.
빈 결과, 잘못된 원본, 부분 조회, 지원하지 않는 옵션, 통신 실패를 구분한다.

## 공식 자료

- 설치본 `lightweight-charts@5.2.0`, [crosshair formatter](https://tradingview.github.io/lightweight-charts/docs/5.2/api/interfaces/LocalizationOptions), [tick formatter](https://tradingview.github.io/lightweight-charts/docs/5.2/api/interfaces/TimeScaleOptions)
- [키움 ka10080](https://openapi.kiwoom.com/m/guide/apiguide/07/ka10080), [공식 API 명세](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/main/kiwoom/_data/kiwoom_api_spec.json)
- [토스 공식 OpenAPI](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json), [시장 데이터 가이드](https://developers.tossinvest.com/docs/market-data), [호출 제한](https://developers.tossinvest.com/docs#rate-limits)
- [NH 공식 국내주식 OpenAPI](https://www.nhplug.com/openapi-docs/krstock/openapi.json)
- [KB 차트 카탈로그](https://openapi.kbsec.com/api/apis/catalog/6de8f4b4-9782-4df3-b94f-c85186de0b10/tr-list), [공식 IVS11560 예제](https://openapi.kbsec.com/api/kbs/guide/test-file/IVS11560)

## 검증과 재현

- `npm run test:server`: 245/245. 차트 시간·직접 주기·합성 OHLCV·포함 커서 중복·호출 상한·타임아웃·개인 키 격리·fallback·잘못된 옵션 포함.
- `node --test tests/chartTime.test.js tests/chartCandles.test.js tests/advancedIndicators.test.js tests/strategies*.test.js tests/theme.test.js`: 29/29.
- `npm run build`: 프로덕션 빌드. 기존 큰 번들 경고는 별도다.
- 로컬 Chrome: 실제 `TradingViewChart`+설치 라이브러리, 모의 네트워크만 사용.
  08:00/08:30/09:00/15:30/20:00 교차선, 6분봉 주기, 일·주·월, 실험실 supplied 일봉,
  SMA/CCI/거래량 시간 정렬, 테마 전환(인스턴스 유지), NH 조회 옵션, 토스 합성 안내,
  빈 결과/오류/부분 조회, 느린 이전 종목 요청 취소를 확인했다.
- 화면: 기본 1234×888, 1366×768, 모바일 390×844, 확대 시 유효 크기에 해당하는
  1093×614 및 911×512에서 가로 넘침 없음. **실제 브라우저 125%/150% 확대와 Windows 배율은 미검증**.
- 포맷터는 `TZ=Asia/Seoul,UTC,America/New_York`의 Node 프로세스에서 동일 결과.
  실제 UTC/미국 시간대 브라우저 프로필은 미검증.
- 보존: 주문/계좌/알림/AI/일봉 DB·수집·실험실 범위를 변경하지 않았다.

로컬 재현: `npx vite --config tests/support/vite.chartTime.config.js`,
`http://127.0.0.1:5183/tests/support/chartTime.html`.
`envDir:false`, 실제 API 전부 차단. 비교 버튼은 검증 화면에서만 기본 UTC 표시를 복원한다.
검증용 원본/호출 계측은 제품 엔트리에서 import하지 않는다.

## 배포 경계

프런트와 서버를 모두 변경했다. SQL/환경변수/의존성/lockfile/systemd unit 변경 없음.
기존 API 배열/ISO 응답도 새 프런트가 읽으므로 서버 반영 전 UI가 깨지지 않는다.
서버가 아직 이전 버전이면 제공 범위 정보 없음으로 표시하고 새 메타데이터를 꾸미지 않는다.
새 서버는 기존 `getCandles/getTossCandles/addedBrokerData.candles` 배열 사용 경로도 보존한다.

VPS `/opt/atlas`의 배포 SHA·clean·조상 관계를 확인하고 `main` 대상 SHA로 fast-forward한다.
일반/차트 읽기 요청 종료를 기다린 뒤 **atlas-api.service만** 정상 중지/기동한다.
AI·평가·알림·DART·일봉 수집·WAL 서비스와 DB는 그대로 둔다. 프런트 빌드는 Vercel에서 수행한다.
공개 health 200, 비인증 계좌 401, 공개 차트의 안전한 범위 메타데이터와 운영 UI를 읽기 검증한다.
실제 주문·취소·카카오·유료 AI는 실행하지 않는다. 개인 응답/비밀값/원문 전체는 출력하지 않는다.
문제 발생 시 기록한 이전 VPS SHA로 detached checkout 후 API만 복원하고,
필요하면 직전 정상 Vercel Production도 복원한다. 강제 reset/DB 복구/일봉 수리는 하지 않는다.
