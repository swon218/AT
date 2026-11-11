# 조건 검색 단위 수정 — 검토와 배포

대상은 전달문에 기재한 **후속 수정 커밋 전체 SHA**이다. main의 더 최신 커밋을 함께 배포하지 않는다. SQL·의존성·환경변수·systemd unit 변경은 없다.

## 2026-11-12 운영 gate 실패 후속 수정 (이 절차 우선)

`6d342854...`의 단위/API 검증은 운영에서 통과했지만 gate의 ‘4회 내 전체 완료’ 가정으로 VPS가 `7719a007...`로 복구됐다. 후속 **`조건 검색 이어서 조회 수정` 커밋 전체 SHA**를 새 TARGET으로 사용한다. 기존 대상 대신 전달받은 새 SHA를 고정하고 아래 내용을 우선한다.

- UI의 4회 자동 호출은 한 번의 사용자 동작에 대한 한도다. 전체 universe 완료 보장이 아니다. 추가 클릭으로 같은 snapshot을 계속 검색한다. UI는 부분 결과를 전체로 표시하지 않는다.
- gate는 여전히 **모든 종목 처리와 완료 캐시 일치**를 요구한다. 요청당 기존 12초, 지표군마다 총 180초, 최대 64회 scan + 완료 캐시 1회로 제한한다. 매회 진행 증가, coverage 무결성, 동일 snapshot/data_version/data_read_at, read transaction 해제를 확인한다. 정체·만료·버전 변경·시간 초과·미완료는 계속 실패다. 기준일·품질·수집 정책은 변경하지 않는다.
- 미완료 진행분은 최초 읽기부터 최대 300초간 보존하며 이어받기로 만료를 연장하지 않는다. 매 요청의 시작·종료 DB/WAL fingerprint 검증은 유지한다. 완료 결과는 완료 시점부터 기존 60초 캐시를 적용한다. `data_read_at`은 최초 읽기 시각을 유지한다. 만료로 다시 시작되거나 버전이 달라지면 UI가 기존 결과를 조용히 덮지 않고 처음부터 검색하도록 안내한다.
- 구 서버(`condition_version` 누락)와 새 UI가 연결돼 있으면 검색/AI 전달을 잠시 막고 ‘업데이트 적용 중’과 데이터 상태 새로고침을 안내한다. 새 서버 단위 계약을 확인하면 사용할 수 있다. `GET /api/screener`의 새 표식은 `continuation_version=bounded-resume-v1`, `progress_ttl_seconds=300`이다.
- 유료 AI 호출 예산, 모델·프롬프트·계산 공식·DB·수집·알림·주문은 변경하지 않는다. Supabase SQL 작업 없음.

### 반영 순서

1. 실제 운영 SHA/clean/서비스 상태를 기록하고 새 TARGET을 fetch한다. 이번에도 `7719a007...`라고 가정하지 말고 실측한다. 예상 밖 변경은 덮지 않는다.
2. 새 TARGET의 격리 worktree에서 전체 Python, 조건검색 Node/HTTP 테스트와 빌드를 실행한다. 추가 검사는 `ai_agent/tests/test_screen_resume.py`, `tests/screenerResume.test.js`이다. 2,719종목 fixture의 6회/8회·60초 초과 재개는 가상 시간/통제 chunk 검증이며 운영 성능 측정은 아니다.
3. **운영 checkout 전**, 조용한 시점에 새 worktree에서 실제 `atlas-ai` 사용자·기존 venv로 운영 DB의 fingerprint와 `python -m deploy.screener_gate --db /var/lib/atlas/lab.sqlite`를 실행한다. module_path가 새 worktree인지 확인한다. RSI/BB/RSI+SMA 세 지표군 모두 `not_scanned=0`, 완료 cache 일치, `SCREENER_READONLY_GATE_PASS`까지 통과해야 한다. 매 호출 및 전체 제한은 위와 같다. 4회 뒤 미완료여도 정상 증가 중이면 정해진 총 한도 안에서 계속한다. 실패하면 **checkout/운영 서비스는 건드리지 않고** 구체적 실패 코드·호출 수·진행률·시간만 보고한다. 운영 DB 행·키는 출력하지 않는다.
4. preflight 통과 후 진행 중 분석·평가·조건검색이 없는 시점에 기존 활성 평가 worker를 정상 정리한다. API → AI 정상 중지, reader 자식 종료 확인 후 정확한 TARGET으로 fast-forward한다. AI → API 기동, 원래 활성 평가 worker만 안전 확인 후 복원한다. 이미 같은 TARGET 프로세스가 실행 중이면 중복 반영/재시작하지 않는다.
5. 환경/의존성/unit/DB/WAL/SHM/수집/DART/알림 worker/WAL guard는 유지한다. 단위/API 검증과 새 continuation 표식을 확인하고 운영 checkout에서도 같은 gate를 재확인한다. 실제 웹에서 부분 조회 → 이어서 검색 → 전체 완료, 진행률·스냅샷·원값/최종 기준, 라이트·다크·모바일을 확인한다. 실제 모델·발송·주문은 하지 않는다.
6. 코드 반영 후 새 장애가 생기면 API/AI/평가를 정상 정리하고 실측 이전 SHA로 복구한 뒤 원래 활성 상태를 복원한다. Vercel도 같은 기준의 정상 배포로 맞출 수 있으면 맞추고, 인증이 없으면 미복구 사실을 명확히 보고한다. 새 UI는 구 서버 계약을 감지해 업데이트 안내로 멈춘다. DB나 조건·대화·알림 이력은 삭제하지 않는다.

최종 보고는 preflight와 반영 후 gate 각각의 지표군별 호출 수/시간/not_scanned/cache/transaction 해제, 코드 SHA/서비스, Vercel SHA/상태와 실제 UI 검증을 구분한다. 고정 4회 완료 기준으로 재검사하지 않는다. 운영 데이터 문제는 별도 원인으로 보고하고 우회하지 않는다.

## 29개 지표 전수 검토

기존 숫자 입력은 단위 없이 공통 기준값 30을 이어받고, 모든 지표를 서로 비교할 수 있었다. 지표 비교 factor 기본값은 1이었다. 개선 후 직접 기준값과 비교 대상은 아래와 같다. 숫자 기본값은 입력 편의를 위한 값이지 매매 판단이 아니다.

| 지표 (총 29개) | 입력·결과 단위 | 직접 기준 기본값 | 지표 간 허용 비교 / 기본 대상 |
| --- | --- | --- | --- |
| 시가·고가·저가·종가, SMA·EMA, BB 상·중·하단, ST 가격선 (10) | 원, 소수 유지 | 10,000 | 가격군 안에서만 / 가격 SMA (SMA 자체는 EMA) |
| 거래량·거래량 SMA (2) | 주, 평균 소수 유지 | 100,000 | 거래량군 안에서만 / 거래량 SMA (SMA 자체는 거래량) |
| RSI (1) | 지수 0~100 | 30 이하 | RSI / RSI |
| MFI (1) | 지수 0~100 | 20 이하 | MFI / MFI |
| ADX (1) | 지수 0~100 | 25 이상 | ADX / ADX |
| +DI·−DI (2) | 지수 0~100 | 25 이상 | DI군 / 반대 DI |
| 스토캐스틱 K·D (2) | 지수 0~100, 주가 수익률 아님 | 20 이하 | K·D / 반대 선 |
| ATR (1) | 원, 가격 수준과 다른 진폭 | 100 이상 | ATR / ATR |
| ATR% (1) | ATR/같은 봉 종가×100, % | 3 이상 | ATR% / ATR% |
| MACD·시그널·히스토그램 (3) | 원, 가격 차이 (음수·0 허용) | 0 이상 | MACD군 / 시그널 (시그널 자체는 MACD) |
| CCI (1) | 지수, 음수·0 허용, 0~100 제한 없음 | −100 이하 | CCI / CCI |
| OBV·OBV 평균 (2) | 주(누적), 음수·0 허용 | 0 이상 | OBV군 / 서로 비교. 일반 거래량과 혼합 금지 |
| ST 방향 (1) | 상태 | 상승 | 1 상승 / −1 하락. 새 조건은 상태 일치 |
| ST 전환 (1) | 상태 | 상승 전환 | 1 상승 전환 / −1 하락 전환 / 0 변화 없음 (첫 유효 방향 포함) |

- 기간·평활: 1~500봉, MACD 시그널은 기존 1~100봉. 현재 확정 일봉 검색이므로 거래일 기준이다. BB 표준편차 배수 0.1~10, ST ATR 배수 0.1~20은 기존대로 배수이며 입력 간격 0.1이다. 기본 BB 20봉/2배, ST 10봉/3배, MACD 12/26/9를 유지한다.
- 직접 기준값은 소수 입력 가능, 위 0~100 지표는 범위를 강제한다. 원/주/ATR/ATR%는 0~10^12, MACD/CCI/OBV는 −10^12~10^12의 기존 전역 상한을 유지한다. 상태는 열거값만 허용한다. 빈 입력은 0으로 바꾸지 않는다.
- 가격·거래량·ATR 같은 양수 계열의 같은 지표군 비교에서만 비율 입력을 제공한다. 기본 100%, 버튼·↑↓ 1%p, 소수는 직접 입력한다. 기존 factor 0.01~1000 계약을 유지하므로 표시 범위는 1~100,000%이다. 200% 이상도 가능하다. 100/110/120/90/200%=factor 1/1.1/1.2/0.9/2. ‘20% 많음’=1.2, ‘20%의 양’=0.2이다.
- RSI/MFI/ADX/DI/Stoch/ATR%와 음수 가능 지표의 지표 간 factor는 고급 배수로 남긴다. 비단위 기존 factor도 계산을 바꾸지 않고 표시한다. 기존 유효 상태 부등호·교차 조건은 코드 비교임을 안내하고 원래 연산을 유지한다. 상태의 신규 정확 일치는 eq이다.
- UI 편집은 지표 전환 시 부적합한 대상·단위를 적절한 기본값으로 바꾸되 사용자가 편집한 유효한 값은 유지한다. 가져온 잘못된 조합은 자동 변환하지 않고 ‘수정 필요’로 실행을 막는다.

## 실제 데이터와 호환성

- `lab/collect.py`의 FDR/NAVER 공급원 OHLC/Volume을 원/주 그대로 저장한다. 평균 거래량은 `ai_agent/indicators.py`의 현재 확정 봉 포함 N개 봉 산술평균이다. 수집 범위·배율·평균 창·지표 공식·품질 격리·확정일·WAL 정책을 바꾸지 않았다.
- 계산 버전 `daily-indicators-v2` 유지. 별도 의미 검증 버전 `screen-units-v1`을 meta/coverage에 표시하고 query_id에 반영한다. 이전 원값을 %로 다시 변환해 계산하지 않는다. 현재/이전 기준에 각각 동일 factor를 곱한 뒤 원래 `>`와 이전 `<=` (하향 반대)로 교차를 판정한다.
- 요청은 기존 factor 계약을 유지한다. UI·Node·Python·AI 도구가 같은 JSON 지표군을 사용한다. 결과는 실제 값·원래 비교 값·factor/비율·최종 기준과 이전 봉 값을 별도로 반환하며 UI에서 반올림 전 값도 펼쳐 볼 수 있다.
- 실제 복원 경로는 App의 공유 useScreener 상태, AI 답변 result_sets.query 및 조건 가져오기다. 조건 localStorage/URL 저장 기능은 원래 없다. importQuery는 잘못된 단위를 유지해 편집할 수 있게 하고, search/서버에서 동일하게 거부한다. 탭 전환·사용자 분리는 기존 경로를 유지한다.
- `AI로 이어가기`는 같은 단위로 요약한 질문 초안만 만든다. 도구 설명과 입력 검증만 바꿨으며 모델·역할·프롬프트 예산·멀티 에이전트 구조·알림/주문 도구는 바꾸지 않았다.

## 통상 참고값의 1차 자료

다음은 유일한 정답이나 수익 보장 조건이 아니다. 거래량 120%·가격 103%는 별도 ‘편의 예시’이다.

- RSI 30/70: https://www.tradingview.com/support/solutions/43000502338-relative-strength-index-rsi/
- MFI 20/80: https://www.tradingview.com/support/solutions/43000502348-money-flow-mfi/
- Stoch 20/80: https://www.tradingview.com/support/solutions/43000502332-stochastic-stoch/
- ADX 20/25: https://www.tradingview.com/support/solutions/43000589099-average-directional-index-adx/
- CCI ±100: https://www.tradingview.com/support/solutions/43000502001-commodity-channel-index-cci/
- 실제 공급원 매핑: https://github.com/FinanceData/FinanceDataReader/blob/master/src/FinanceDataReader/naver/data.py (`Volume` 원값; ATLAS `lab/collect.py`에서도 그대로 전달)

## VPS 헤르메스 반영 절차

1. `/opt/atlas` 현재 SHA, clean 여부, 실제 서비스 사용자/venv/환경파일 경로, AI·API·평가 worker의 원래 활성 상태를 비밀값 없이 기록한다. `git fetch origin main`; TARGET이 origin/main에 포함되고 CURRENT가 TARGET의 조상인지 확인한다. 다른 변경·dirty 상태는 덮어쓰지 않는다.
2. TARGET의 격리 worktree에서 기존 잠금 기준으로 테스트한다. 운영 환경을 읽지 않는 fixture를 사용하고 운영 venv에 pytest를 추가하거나 의존성을 올리지 않는다. `python -m pytest ai_agent/tests -q -rs`; `node --test tests/screener.test.js tests/advancedIndicators.test.js server/screener.test.js`; `AI_TEST_PYTHON=<격리 python> node --test tests/screenerIntegration.test.js`; `npm run build`. 새 패키지 설치나 SQL은 운영에 필요 없다.
3. 변경 Python 파일/JSON은 import와 이후 reader/도구 실행 때 읽힐 수 있다. 실행 중 `/opt/atlas`를 먼저 전환하면 프로세스 내부 코드가 섞일 수 있으므로 **진행 중 분석·조건검색·평가가 끝난 조용한 시점**을 잡는다. 평가 worker는 정상 종료로 claim을 막고 이미 실행 중인 작업의 종료를 기다린다. 큐나 실제 유료 요청을 배포 확인 목적으로 생성·재시도·삭제하지 않는다. 장시간 요청이 남으면 코드 전환을 미루고 기존 서비스 상태를 유지한다.
4. 먼저 `atlas-api.service`, 다음 `atlas-ai.service`를 정상 중지하고 소유 reader/fingerprint 자식 프로세스가 종료됐는지 확인한다. 강제 종료로 진행 중 작업을 무시하지 않는다. 실행 중 수집은 `lab` 모듈을 쓰며 이번에 변경된 `ai_agent`/`shared/screener*`를 읽지 않는다. 수집/DART/알림 worker/WAL guard는 수정·재시작하지 않는다. 기존 일봉 DB·WAL·SHM을 삭제·복사 교체·checkpoint·권한 변경하지 않는다. 수집으로 DB 내용이 정상 갱신되는 것을 고정 해시 불일치만으로 장애로 판단하지 않는다.
5. clean checkout에서 `git merge --ff-only "$TARGET"`로 정확한 커밋을 반영한다. 기존 Node/Python 패키지, 모든 환경파일·unit·스케줄·암호화/공급자 키를 유지한다. `shared/screener-metrics.json`, 스키마와 새 Python 모듈이 실제 서비스 사용자에게 읽히는지 확인한다. daemon-reload는 불필요하다.
6. **AI → API** 순서로 기동한다. 평가 worker는 원래 active였고 남은 유료/진행 중 작업 상태가 안전한 경우에만 원상 기동한다. 원래 inactive면 그대로 둔다. 다른 서비스를 재시작하지 않는다.
7. loopback/외부 `/api/health` 200, 내부 AI 비인증 `/health`·`/screen` 401, 임의 origin의 `/api/screener` 403, 기존 개인 계좌 API 비인증 401을 확인한다. 내부 인증은 기존 안전한 관리 경로를 사용하고 헤더·토큰·환경파일 본문은 출력하지 않는다.
8. GET `/api/screener`에 `condition_version=screen-units-v1`인지 확인한다. 수동 공개 조건검색은 로그인 없이 허용되는 기존 기능이다. 운영 출처의 POST로 거래량 vs 가격 SMA, RSI 101, 상태 2를 거부하는 400 안전 코드, 유효한 120%/200% 요청의 factor 보존·단위·원값/최종 기준·coverage를 읽기 전용으로 확인한다. 수집/품질 때문에 제외되면 그 사유를 보고하고 기준일·정책을 우회하지 않는다. 상태 eq와 과거 부등호 조건도 확인한다.
9. 실제 `atlas-ai` 사용자로 기존 `/opt/atlas/.venv-ai/bin/python -I -S ai_agent/snapshot_fingerprint.py /var/lib/atlas/lab.sqlite`와 `python -m deploy.screener_gate --db /var/lib/atlas/lab.sqlite`를 읽기 전용 실행한다. 실제 DB 경로는 현재 unit 설정과 대조한다. 기존 WAL guard/권한을 유지하고 실패 시 stale/격리/수집 commit 등 원인을 구분한다. DB 수리·재수집은 하지 않는다.
10. 서버를 먼저 확인하고 Vercel Production의 TARGET SHA/배포 ID/상태를 확인한다. main 자동 배포가 먼저 시작됐다면 **VPS 완료 전 통합 배포 완료로 보고하지 않는다.** 구 서버는 새 eq와 상세 필드를 지원하지 않으므로 서버 반영 후 UI를 다시 확인한다. 운영에서 거래량 120% 미리보기, 잘못된 복원 조건의 수정 안내, 한글 상태, 음수 배수, 결과 원값/최종 기준, 라이트·다크·모바일 도움말을 확인한다. 실제 모델 호출·카카오·알림 변경·주문은 하지 않는다.
11. 이상 시 API와 AI/평가의 실행을 정상 정리한 뒤 기록한 이전 SHA로 승인된 코드 복구 절차를 적용한다. 이 배포와 무관한 사용자 변경을 reset하지 않는다. AI → API, 원래 active였던 평가 worker를 복원하고 health/인증을 재확인한다. Vercel도 기록한 직전 정상 Production으로 되돌려 두 계층을 맞춘다. **DB와 기존 조건·대화·평가·알림 데이터는 복구 과정에서도 삭제하지 않는다.**

보고는 코드 push/Vercel/VPS를 각각 구분한다. Supabase SQL 작업 없음. 실제 모델의 자연어 도구 선택·운영 데이터 결과는 로컬 fixture 테스트와 구분한다. 테스트·현재 SHA·서비스 상태·운영 UI 검증/미검증과 복구 여부만 보고하고 비밀값·개인 대화·회원/계좌 원문을 보내지 않는다.
