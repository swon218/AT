# 대시보드 주요 데이터 배포

상단 카드의 장 상태, 거래대금, 상승·보합·하락 분포, 외국인 순매수, 기관 순매수를 키움에 연결한다. 원/달러는 연결 예정 상태로 유지한다.

## VPS 작업

기존 경로 `/opt/atlas`, 소유자 `atlas`, 서비스 `atlas-api.service` 기준이다. 실제 운영 경로와 포트가 다르면 기존 설정을 사용한다.

1. 현재 HEAD, 브랜치, 로컬 변경, API 서비스 상태를 기록한다. `.env` 및 로컬 변경을 보존한다.
2. 저장소 소유자 권한으로 `main`을 fast-forward 업데이트한다. 로컬 변경이나 브랜치 충돌을 강제로 덮어쓰지 않는다.
3. **이번에는 `ws` 의존성이 추가되어 `npm ci`가 필요하다.** 현재 운영 Node 환경과 저장소 소유자를 사용한다.
4. 서버 테스트가 통과하면 API 서비스를 재시작한다. 설치 또는 테스트 실패 시 기존 서비스를 임의로 중단하지 말고 실패 원인을 확인한다.

```sh
cd /opt/atlas
git status --short
git rev-parse HEAD
sudo -u atlas git pull --ff-only origin main
sudo -u atlas npm ci
sudo -u atlas npm run test:server
sudo systemctl restart atlas-api.service
sudo systemctl status atlas-api.service --no-pager
curl --fail http://127.0.0.1:3000/api/health
curl --fail http://127.0.0.1:3000/api/public/market/kiwoom/summary
curl --fail http://127.0.0.1:3000/api/public/market/kiwoom/session
```

각 단계가 성공한 경우에만 다음 단계를 실행한다. `npm ci`는 VPS에서 사용하는 Node/npm 실행 경로로 실행한다.

- 신규 환경변수나 키 발급은 필요 없다. Supabase 테이블·SQL·RLS 변경도 없다.
- 키움 허용 IP에 VPS 공인 IP가 등록되어 있어야 한다.
- 기존 HTTPS 외에 **VPS에서 `api.kiwoom.com:10000`으로 나가는 WSS 연결**이 필요하다. 들어오는 10000 포트를 열거나 프록시 WebSocket 경로를 추가할 필요는 없다. 연결 실패 시 기존 outbound 정책을 확인하고 필요한 대상만 검토한다.
- 키움 키·접근토큰은 VPS 내부에서만 사용한다. 환경파일, 키, 토큰, WebSocket LOGIN 원문은 로그나 보고서에 출력하지 않는다.
- 실험실 SQLite, Python 환경, 수집 서비스·타이머는 변경하거나 재시작하지 않는다.
- Vercel 프런트엔드 배포는 별도다. 같은 변경을 포함한 커밋이 배포되었는지 확인한다.

## 확인 기준

### 시장 요약

`/api/public/market/kiwoom/summary`의 `markets`에 `kospi`, `kosdaq`가 있고 각 시장의 `quoteError`, `flowError`가 null인지 확인한다. HTTP 200만으로 성공 판정하지 않는다.

- `asOf`: 최근 거래일. 휴장일에는 전 거래일이 정상이다.
- `turnoverWon`: 원 단위 거래대금. `ka20001.trde_prica`의 백만원을 원으로 변환한다.
- `breadth`: 상승·보합·하락 및 상한·하한 종목 수. 상승·하락에 상한·하한을 다시 더하지 않는다.
- `foreignNetBuyWon`, `institutionNetBuyWon`: 원 단위 순매수. `ka10051` 금액 구분 응답의 억원을 원으로 변환한다.
- KRX 기준(`stex_tp=1`), 코스피 `001` / 코스닥 `101` 종합 행만 사용한다. 하위 업종 행을 합산하지 않는다.
- 결측값은 null과 오류 표시를 유지한다. 0으로 채우지 않는다.
- 서버 캐시 및 화면 갱신은 30초이며, 관리자/사용자/키 버전에 따라 분리한다. 장중 수급은 조회 시점의 집계값이다.

### 장 상태

`/api/public/market/kiwoom/session` 첫 요청이 연결을 시작한다. 5~10초 후 다시 조회해 `connection=connected`인지 확인한다. 이는 키움 WebSocket LOGIN과 `0s` 구독 승인이 완료되었다는 의미다.

- `source=kiwoom`: 당일 KRX 장운영 이벤트를 수신했다. `receivedAt`, `marketTime`, `label`을 확인한다.
- `source=calendar`: 주말이어서 한국시간 달력 기준으로 휴장을 표시한다. 실시간 상태 수신으로 오인하지 않는다.
- `source=pending`: 평일 장운영 이벤트 수신 전이다. 거래 중 또는 공휴일 휴장으로 임의 확정하지 않는다. 재시작/재접속 시 장운영 이벤트가 올 때까지 수신 대기일 수 있다.
- `stale=true`: 연결이 끊겼거나 재연결 후 상태가 다시 확인되지 않아 마지막 상태를 표시한다.
- `0s`의 NXT 및 선물옵션 이벤트는 KRX 주식 카드에 반영하지 않는다.
- 화면은 10초마다 서버의 장 상태를 읽는다. WebSocket 연결은 자격 증명별로 공유하고, 2분 동안 조회가 없으면 정리하며 다음 요청 때 다시 연결한다.
- 주말에 LOGIN/구독만 확인했다면 정규장 전환의 실제 수신까지 검증했다고 보고하지 않는다. 운영일의 장운영 이벤트 수신 여부는 별도로 구분한다.

### 화면과 권한

- 여섯 카드 중 원/달러만 `연결 예정`이며 다른 카드에 실데이터가 표시되는지 확인한다.
- 코스피·코스닥 두 시장의 금액, 부호, 등락 막대 및 기준일을 확인한다.
- 비로그인/개인 키 미등록 시 관리자 키, 개인 키 등록 시 사용자 키를 사용한다. 개인 인증 오류를 관리자 키로 숨기지 않는다.
- 기존 시장 순위 / 관심종목, 지수 차트, 뉴스가 정상인지 확인한다. 실제 주문은 테스트하지 않는다.

## 근거

- [키움 공식 API 명세](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/main/kiwoom/_data/kiwoom_api_spec.json): `ka20001` 거래대금 백만원, `ka10051` 금액 구분 억원, `0s` 장운영구분 및 NXT 코드.
- 로컬에서는 두 시장의 요약 실데이터와 WebSocket LOGIN/구독 성공을 확인했다. 주말이므로 정규장 전환 이벤트 실수신은 미확인이다.
