# Market Data Agent

총괄의 market 위임은 `resolve_market_symbol`, `get_market_quote`, `get_intraday_bars`로 이어진다. 기존 운영자 키움 공개 시세 연결과 종목 목록, `getStockQuote` 정규화, `chartDefinition`을 재사용한다. 회원 개인 키와 계좌는 이 경로에 들어오지 않는다.

Python은 서버가 보유한 request_id와 기존 AI_INTERNAL_SECRET을 사용해 고정 loopback `/api/internal/agent/data`만 호출한다. Node는 내부 인증, 현재 실행 요청과 기존 DB 소유권·running 상태를 확인한다. 모델에는 코드·시세·조회 메타데이터만 전달한다. Vercel 프록시의 허용 경로를 확대하지 않는다.

현재 지원 시장은 KRX다. NXT·SOR는 명시적인 unsupported_market 결과를 반환한다. ka10001의 가격·전일 대비·등락률·누적 거래량을 읽으며 공급자 시세 시각과 실시간·지연은 확인 불가로 표시한다. 현재 정규장 상태는 기존 검토된 XKRX 달력으로 별도 표시한다. 일봉 종가 대체는 하지 않는다.

분봉은 기존 웹의 1·5·10·15·30·60분, 틱은 공식 예제의 1·3·5·10·30틱이다. 수정주가를 요청한다. 날짜를 포함한 체결시간을 검증하고 미완성·확정 여부는 공급자가 제공하지 않는 상태로 명시한다. 모델로 전달하는 개별 봉은 최근 24개이며, 전체 수신 최대 120봉의 OHLC·거래량·개수·실제 범위는 일반 코드가 요약한다.

앱은 최대 7개 달력 날짜·2페이지를 조회한다. 이 제한은 요청 예산과 응답 크기를 위한 앱 한도다. 공급자의 전체 보존기간을 보장하는 값이 아니다. 분봉의 기준일자는 전달하지만 틱의 임의 과거 기준일자는 지원하지 않으며, 실제 받은 범위를 명시한다. 기간 밖 자료만 수신하거나 페이지·개수 제한에 걸리면 부분 조회를 반환한다. 같은 시각의 실제 여러 틱을 보존하고 페이지 경계의 중복 구간만 제거한다.

동일 공개 권한·자격증명 버전·종목·주기·기간은 최대 5초 캐시와 진행 중 요청을 공유한다. 실제 공급자 읽기는 Node에서 250ms 간격으로 제한한다. Python은 내부 읽기 전에 최대 공급자 요청 수를 공통 외부 예산에 예약하고, 정제된 응답의 실제 사용량으로 정산한다. Node도 요청별 최대 8회와 개별 읽기의 상한을 강제한다. 캐시 적중·조회 시각·시세 시각을 구분한다.

관리자 목록은 코드 등록, 운영 담당 등록, 설정 여부, 최근 실제 수신 시각을 각각 표시한다. 구버전 서버에는 준비 미확인 상태를 표시한다. 과거 운영 점검 JSON은 수정하지 않는다. 신규 고정 시세 평가 사례는 기존 사례와 별도 seed ID를 사용한다. 회원·seed별 결정적인 UUID와 기존 revision 제약으로 중복 등록을 막고 기존 사례를 보존한다.

공식 자료는 다음과 같다.

- [키움 주식 기본정보 ka10001](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/main/examples/국내주식/종목정보/get_domestic_stock_info.py)
- [키움 분봉 ka10080](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/main/examples/국내주식/차트/get_domestic_stock_minute_chart.py)
- [키움 틱 ka10079](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/main/examples/국내주식/차트/get_domestic_stock_tick_chart.py)

첫 단계는 모의 모델·고정 공급자 및 실제 HTTP 경계 테스트로 검증한다. 실제 공급자 수신·실제 모델 판단은 운영 확인과 구분한다. Supabase 추가 SQL과 신규 환경변수는 없다. 기존 Node 환경의 키움 시세 키와 AI의 내부 인증·callback 설정을 재사용한다. API·AI·평가 worker 반영은 후속 Fundamental Research Agent를 포함하는 최종 SHA로 함께 진행한다.
