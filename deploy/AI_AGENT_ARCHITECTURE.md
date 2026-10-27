# ATLAS 조사 에이전트 v1

요청에 따라 구현한 소스의 구조와 검증 경계다. 운영 상태를 의미하지 않는다.

## 실행과 권한

React의 두 채팅 화면은 `useServerAgentWorkspace` 한 인스턴스를 공유한다. AI API는 기존 `VITE_API_BASE_URL`과 무관하게 `/api/agent` 동일 출처를 사용한다. Vite는 개발 프록시, Vercel은 `api/agent/[...path].js`의 서버 프록시를 사용한다. Vercel 서버 환경변수 `ATLAS_API_ORIGIN`은 실제 HTTPS VPS API origin이다.

Node는 Supabase Auth의 `getUser(token)`으로 로그인만 검증한다. `accountSettings.js`의 기존 브로커 암호화 필수 검사는 그대로 유지했다. 로그인에 브로커 키를 요구하지 않는다. 잘못된 Bearer는 401이며 guest로 전환하지 않는다. guest는 `/status`에서만 서명된 HttpOnly/SameSite=Lax 쿠키를 발급한다. 나머지 API는 쿠키 누락 시 거부한다. 만료/위조 쿠키를 새 방문자로 자동 대체하지 않는다. 쿠키 삭제/다른 브라우저의 동일인 완벽 식별은 보장하지 않는다. IP를 사용자로 사용하지 않는다. production 쿠키는 Secure + `__Host-` 접두사다. Origin과 Sec-Fetch-Site를 검증한다. 프록시를 통한 동일 출처 쿠키이므로 제3자 쿠키에 의존하지 않는다.

`atlas_ai_rpc`는 service_role만 실행한다. 모든 데이터 테이블은 격리된 `atlas_ai` 스키마에서 RLS를 활성화하고 직접 클라이언트 권한을 회수했다. 소유자 advisory lock, 복합 FK, 요청 ID PK로 소유권/원자적 예약/멱등 완료를 강제한다. 질문 1건당 guest 1회이며 KST 날짜별 used+reserved가 2에 도달하면 거부한다. 로그인 일일 횟수는 무제한이며 모든 사용자의 동시 실행 1개/분당 새 요청 10개는 별도다. 서버/공급자 실패는 질문 횟수를 복구한다. 정상 되묻기/자료 부족은 정상 완료로 차감한다. 삭제로 이미 사용한 횟수가 초기화되지 않는다.

FastAPI는 loopback 8010 + 최소 32자 내부 비밀로 보호한다. Node와 공유하는 키는 AI_INTERNAL_SECRET 하나이며 별도 환경파일을 사용한다. production에서 브로커 환경변수가 유입되면 기동을 거부한다. 주문, 계좌, 셸, SQL, 임의 URL 도구는 없다. 뉴스 URL은 출처 링크로만 사용하고 가져오지 않는다. 명시적 tools 스키마에 없는 호출은 실행하지 않는다.

## 모델과 도구 루프

기본은 `OPENAI_MODEL=gpt-6-luna`, 공식 Python SDK 3.40.0이다. `ai_agent/requirements.lock`은 전이 의존성과 해시까지 고정한다. Python 3.10 이상을 사용한다. 공식 모델 문서에서 Responses/함수 호출/structured output 지원을 확인했고 실제 SDK의 요청 형식은 HTTP mock transport로 검사했다. 계정별 모델 접근 권한과 실제 모델 응답 품질은 키 부재로 미검증이다. 다른 모델로 자동 변경하지 않는다.

`runner.py`는 제한된 반복 루프이고 production에서 키워드로 조사 경로를 고정하지 않는다. 모델이 요청한 도구를 스키마와 업무 규칙으로 검증하고 실제 결과를 해당 `call_id`의 `function_call_output`으로 넣은 뒤 다시 모델을 호출한다. 이 다음 턴에서 추가 조회/되묻기/최종 답변을 모델이 선택한다. reasoning continuation을 포함한 전체 `response.output`을 다음 입력에 유지한다. `store=False`와 `reasoning.encrypted_content`를 사용하고 불투명한 연속성 항목은 실행 중 RAM에만 존재한다. 숨겨진 사고 원문이나 전체 프롬프트는 DB/로그로 저장하지 않는다. 서버 재시작 시 저장 대화는 복원하지만 중단된 공급자 요청을 자동 재실행하지 않는다.

도구: `resolve_symbol`, `get_market_context`, `screen_rsi`, `get_stock_news`, `get_news_details`. 모델 공급자, 도구, 실행 루프, Node 저장소를 분리했다. 환경변수로 fixture를 선택할 수 없으며 production app은 `AI_PROVIDER != openai`를 거부한다. `ai_agent/tests/dev_service.py`는 독립된 테스트 진입점이며 production 진입점이 아니다.

한도 기본값: 모델 8왕복/도구 12회/실제 외부 요청 8회/뉴스 6종목/원자료 기사 60개/스크리닝 3,000종목/확인 사용량 40,000토큰/한 번 출력 2,048토큰/전체 120초/도구 12초/보정·오류 복구 2회. news는 회당 10건, 최대 3페이지, RSI는 페이지당 최대 20개다. 스크리닝은 명시적 code 정렬과 잘림 수를 보고하고 조건 일치는 RSI 오름차순/코드 오름차순이다. 같은 도구/같은 인자 반복은 차단한다. SDK 자동 재시도는 0이다. 과금 여부가 불확실한 타임아웃/응답 유실/결제·권한 오류는 자동 재전송하지 않는다. 모델이 구조화된 도구 오류를 받고 다른 조건을 선택하는 복구도 한도에 포함한다.

매 모델 요청 전 UTF-8 byte 수 + 프로토콜 여유를 이용한 보수적인 입력 상한과 출력 예약으로 다음 요청을 허용할지 결정한다. 확인된 입력·출력·추론·캐시 토큰을 왕복 전체에 합산한다. 추론 토큰은 output의 부분집합이므로 총토큰/비용에 이중 합산하지 않는다. 기본 `AI_INPUT_USD_PER_MILLION=1`, `AI_OUTPUT_USD_PER_MILLION=4`, `AI_MAX_USD=0.25`는 보수적인 예산 계수이며 실제 가격·청구 보장이 아니다. 현재 요율이 이 계수를 넘지 않는지 활성화 전 확인한다. 사용량 미확인 구간은 status=unknown이며 이미 확인한 누적값은 보존한다. unknown 상태에서는 추가 모델 호출을 멈춘다.

## 자료와 검증

RSI는 기존 `calculateRsi`와 같은 초기 평균 및 Wilder 평활, 보합=50, 상승만=100 규칙이다. 기존 SQLite 스키마의 symbols/candles/current_candle_quality를 읽기 전용 트랜잭션으로 조회한다. 저장된 최대 2,000봉을 사용하고 최신 확정 거래일보다 오래됨, 거래일 누락, 준비 봉 부족, 격리 OHLC, 품질 기록 없음, 유효하지 않은 봉을 제외·공개한다. 전체 국내 시장 목록이 아니라 실제 수집 universe를 보고한다. 이전 검색의 result_sets/코드/수치/기준일은 서버 답변과 함께 저장해 후속 질문의 문맥으로 전달한다.

거래일은 exchange_calendars 4.13.2 XKRX를 사용하고 검증 허용 범위를 기본 2026-12-31까지로 제한한다. 해당 범위를 넘어선 확정적 판단은 거부한다. 운영자는 임시 휴장/거래시간 변경을 확인한 뒤 달력 패키지와 범위를 갱신해야 한다. 밤사이는 직전 거래일 실제 정규장 마감부터 해당 거래일 정규장 시작까지이며 현재 시각을 넘지 않는다. 휴일에는 다음 거래일을 대상으로 현재까지 자료라는 범위를 공개한다. today와 overnight 기간을 구분하며 기사에도 overnight/intraday 구분을 기록한다.

Naver legacy는 기존 `https://openapi.naver.com/v1/search/news.json`, HUB는 `https://naverapihub.apigw.ntruss.com/search/v1/news`를 사용한다. AI env의 전용 이름은 `AI_NAVER_MODE=legacy|hub`, `AI_NAVER_CLIENT_ID`, `AI_NAVER_CLIENT_SECRET`이다. 기존 Node 뉴스는 기존 설정과 경로를 그대로 보존했다. HUB에는 새 NCP 키가 필요하고 기존 키와 교환 사용할 수 없다. API HUB는 2026-06-25 개시, 기존 개발자센터 신규 신청은 2026-07-31 차단, 이전 신청분 지원은 2027-06-30 종료라는 공지를 확인했다. 운영 계정 이관 및 실제 호출은 미검증이다.

뉴스는 제목/검색 요약/네이버 제공 시각만 확보한다. 원문 확보라고 표시하지 않는다. URL/동일 제목 중복을 제거하고 동일 사건 판단은 모델이 제한된 자료에서 수행한다. 직접 연관 후보와 간접·무관 검토 필요를 구분한다. 출처에는 발행/제공 시각, 수집 시각, 분석 기준 시각, 검색 범위가 포함된다. 검색 실패/빈 결과/자료 부족은 분리한다. 공개 원자료 캐시는 조회·페이지·기간 필터 전 자료·모델/프롬프트 버전 키로 60초, 최대 256개이며 동일 조회는 singleflight한다. 새 자료·정정은 최대 TTL 이후 재조회하며 원자료 hash 기반 기사 ID가 바뀐다. 개인 분석 답변은 공용 캐시에 넣지 않는다. 같은 요청 ID의 분석 중복은 DB 예약과 5분 프로세스 메모리 결과 캐시로 억제한다. 개인 문맥이 다른 요청의 모델 결과는 재사용하지 않는다. 공용 원자료 캐시는 만료 시 요청 중 정리되며 재시작으로도 제거된다.

최종 JSON뿐 아니라 source ID, 인용 원문 일치, 수치 존재/RSI 정확한 서버 수치, 기업 관련성, 단어 내용 겹침/명백한 증가·감소 등 사실 반전, 최신 질문의 새 조회 근거 필요 여부를 검사한다. 요약에 근거 없는 최신 수치를 넣을 수 없다. 실패 시 최대 2회 보정 후 실제 확보 자료만 담은 부분 결과 또는 실패다. 서버가 실제 coverage를 별도로 붙이므로 일부 조사 종목 수/미조사 수를 생략할 수 없다. 이 결정적 검사는 완전한 한국어 의미 함의 판정이 아니며 모델의 분류/서술 품질을 보증하지 않는다. 실제 모델의 관련성/내용 부합/직접·간접/감성 평가를 활성화 후 소수 검증 질문으로 수행해야 한다.

## 대화와 복구

최근 같은 방 12개 메시지와 날짜/근거/result_sets 메타데이터만 문맥에 넣으며 Node에서 약 24KB로 제한한다. 오래된 주장은 날짜가 있는 과거 자료다. 과거 답변 전체를 무제한 전송하거나 자동 최신 근거로 취급하지 않는다. 자유 생성 대화 요약은 만들지 않고 원래 근거 메타데이터를 유지해 요약 변형을 피한다. 오래된 맥락이 잘리면 모델이 조건을 되묻게 한다.

상태/단계는 poll로 DB에서 읽고 검증 완료된 답변만 assistant 메시지로 저장한다. 글자 단위 스트리밍이나 DB 쓰기는 없다. 전송 전에 요청 ID를 로컬 UI 설정에 보관하고 중복 전송/재연결에 같은 ID를 사용한다. 실행 lease는 단계마다 180초로 갱신한다. 중단 후 만료 lease는 failed + unknown 사용량으로 종료하고 횟수 예약을 복구한다. 이미 확인한 사용량은 남긴다. 삭제한 방은 tombstone 처리하고 late completion은 cancelled로 끝나며 메시지를 재생성하지 않는다. 실행 중 삭제는 다음 실제 이벤트 확인에서 후속 모델 호출을 중단한다. 삭제 취소 기능은 제공하지 않는다.

로그인 대화는 사용자가 삭제할 때까지 messages에 남는다. guest는 기본 7일이며 AI_GUEST_DAYS로 1~30일 설정한다. request 실행 상세는 90일 후 질문/답변을 정리하고 steps는 30일 보관한다. 삭제 방의 메시지/요청 본문도 정리한다. 일일 사용량과 최소 익명 요청 기록/guest 해시는 채팅과 분리해 유지하므로 삭제로 한도가 초기화되지 않는다. cleanup timer는 AI 테이블만 건드린다. 운영자에게 별도 전체 개인정보 보존 정책이 있으면 버전 migration으로 그 정책을 변경해야 한다.

기존 localStorage 질문은 자동 삭제/다른 계정 업로드하지 않는다. 해당 계정의 이전 브라우저 기록에서 읽기 전용으로 확인/복사할 수 있다. 새 UI 설정/초안만 별도 키에 저장한다. 계정 scope가 바뀌면 렌더 전에 이전 메시지를 제거하고 이전 요청 응답도 scope 검사로 무시한다. 로그인 대화는 서버를 통해 다른 기기에서 조회된다. 답변은 React text + 제한된 강조/인라인 코드로 렌더링하고 임의 HTML/Markdown 이미지/모델 URL은 실행하지 않는다. 실제 서버 출처 http(s) 링크만 별도 렌더링한다.

## 공식 근거 (2026-10-28 확인)

- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Responses function calling and continuation](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI Python SDK](https://github.com/openai/openai-python)
- [Naver 이관 공지](https://developers.naver.com/notice/article/32530)
- [API HUB 뉴스 계약](https://api.ncloud-docs.com/docs/naver-api-hub-search-news)
- [API HUB 이관 절차](https://guide.ncloud-docs.com/docs/apihub-migration)
- [거래소 달력 라이브러리](https://github.com/gerrymanoim/exchange_calendars)
