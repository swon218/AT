# VPS 헤르메스 전달문 — NH투자증권·KB증권 추가

ATLAS 저장소 `https://github.com/swon218/AT`의 `main`에 올라온 `증권사 추가` 커밋을 VPS API 서버에 적용해 주세요. 실제 매매 주문을 테스트로 보내지 마세요. 기존 키움·토스 설정과 사용자 키 암호화 키는 유지합니다.

## 1. 배포 전 확인

1. ATLAS에 연결된 Supabase 프로젝트에서 `deploy/BROKERS_SUPABASE.sql`을 먼저 실행했는지 확인하세요. 미실행이면 이 파일을 SQL Editor에서 실행해야 합니다. 기존 `user_integrations`에 `nh_configured`, `kb_configured`가 생기고 `broker_order_requests` 테이블이 있어야 합니다.
2. `atlas-api.service`의 실제 `WorkingDirectory`, 실행 사용자, 환경 파일 위치를 확인하세요. 환경 변수의 **값은 출력하지 마세요**. 운영 중인 저장소에서 `git status --short`로 로컬 변경을 확인하고 덮어쓰지 마세요.
3. 기존 `ATLAS_CREDENTIAL_ENCRYPTION_KEY`, Supabase 비밀 키, 키움·토스 키를 교체하지 마세요.

## 2. 서버 환경 변수

사용자가 로컬 `.env`에 저장한 NH 키는 GitHub에 포함되지 않습니다. 이미 VPS에 키가 없으면 사용자가 안전한 방법으로 VPS 환경 파일에 직접 넣도록 안내하고, 키를 채팅/로그/커밋에 남기지 마세요.

```dotenv
# 로컬에서 사용 중인 변수명을 그대로 지원합니다. 대문자 NH_APP_KEY/NH_SECRET_KEY도 지원.
NH_app_key=<관리자 NH 앱키를 서버에서 입력>
NH_secret_key=<관리자 NH 시크릿키를 서버에서 입력>
NH_API_HOST=https://api.nhplug.com:8443
NH_ORDERS_ENABLED=true

# KB 관리자 계좌 개설 전까지는 비워둡니다. KB 개인 키가 없는 사람의 차트는 관리자 키움으로 조회합니다.
KB_app_key=
KB_secret_key=
KB_ORDERS_ENABLED=true
KB_CLIENT_IP=<이 VPS의 실제 외부 송신 IP>
KB_CLIENT_MAC=<실제 송신 네트워크 인터페이스의 MAC 주소>
```

`NH_ORDERS_ENABLED`와 `KB_ORDERS_ENABLED`는 웹에서 이용자가 직접 확인한 주문을 받도록 활성화하는 설정입니다. 관리자 키로 주문하지 않습니다. 키/DB/네트워크 사전 조건을 갖춘 후 설정하세요. 설정 누락 시 해당 증권사 주문은 서버에서 거절됩니다.

NH 계정은 나무 PLUG(`nhplug.com`) 기준입니다. N2 도메인 키는 지원 범위가 아닙니다. 모의투자 시에는 `NH_API_HOST=https://moapi.nhplug.com:8443`로 설정합니다. 토큰·계좌 목록·차트는 NH 공식 규격에 따라 운영 호스트를 사용하며, 잔고·주문은 모의 계좌(`acct_type=03`)로 제한됩니다.

KB의 `dataHeader.ipAddr/macAddr`는 실제 VPS 정보를 설정해야 합니다. KB API 사용신청의 IP 제한 설정이 있다면 실제 송신 IP와 일치해야 합니다. KB 관리자 키가 없어도 개인 키로 주문할 수 있지만 이 공통 헤더 설정은 필요합니다. 향후 관리자 KB 키를 넣으면 미등록 사용자의 차트도 자동으로 KB 관리자 시세로 바뀝니다.

## 3. 코드 적용

확인한 실제 저장소 경로에서 순서대로 실행하세요.

```bash
git pull --ff-only origin main
npm ci
npm run test:server
npm run test:strategies
npm run build
sudo systemctl restart atlas-api.service
sudo systemctl is-active atlas-api.service
```

VPS 방화벽에서 NH `api.nhplug.com:8443`, KB `developer.kbsec.com:32484`에 HTTPS 아웃바운드 통신이 가능해야 합니다. TLS 인증서 검증을 끄지 마세요. Vercel 프런트엔드는 GitHub push에 따른 배포 성공 여부를 별도로 확인하세요.

## 4. 읽기 전용 확인

실제 서비스 포트에 맞춰 확인하세요(기본 3000).

```bash
curl --fail --silent http://127.0.0.1:3000/api/health
curl --fail --silent 'http://127.0.0.1:3000/api/public/market/nh/candles?symbol=005930&interval=%EC%9D%BC&limit=5'
curl --fail --silent 'http://127.0.0.1:3000/api/public/market/kb/candles?symbol=005930&interval=%EC%9D%BC&limit=5'
```

- NH는 `sourceBroker=nh`, 유효한 캔들이 있어야 합니다.
- KB 관리자 키가 비어 있으면 `sourceBroker=kiwoom`, `fallback=true`여야 합니다. 화면에는 `키움 캔들 데이터 · 대체 시세`가 표시됩니다.
- 비로그인의 `/api/account/nh/summary`, `/api/account/kb/summary` 접근은 401이어야 합니다. 주문 엔드포인트로 테스트 요청을 보내지 마세요.
- 사용자 키 저장/개인 계좌 조회는 사용자가 로그인한 웹에서 확인하도록 안내하세요. NH 계좌가 여러 개면 선택 후 조회됩니다. KB는 API 신청 시 연결된 계좌를 사용합니다.
- DB/세션 오류나 **등록한 개인 키의 인증 실패**는 관리자 키로 대체하지 않고 오류를 표시해야 합니다.
- HTTP 200만으로 주문/체결 검증 완료라고 보고하지 마세요. 실제 주문은 사용자가 웹에서 직접 수행합니다.

보고할 내용: 적용 커밋, SQL 적용 여부, 서비스 상태, NH 캔들 건수, KB 대체 시세 여부, 환경 변수의 설정 여부(값 제외), 아직 확인하지 못한 항목. KB 개인 키가 없으면 개인 계좌·주문 실연동은 미검증으로 남겨 주세요.

## 주문 응답이 불확실할 때

`broker_order_requests`의 `pending/uncertain`은 증권사 주문 내역과 대조해야 합니다. 같은 요청 ID는 재전송하지 않습니다. 접수 후 서버 재시작/타임아웃이 발생해도 DB 기록이 중복 전송을 차단합니다. 주문을 다시 하려고 이 기록을 삭제하지 마세요.

## 구현 근거와 검증 범위

- NH: https://www.nhplug.com/openapi-docs/common/openapi.json 및 https://www.nhplug.com/openapi-docs/krstock/openapi.json
- KB: https://openapi.kbsec.com/apidoc_b2c 및 공식 상세 TR 명세/JSON 샘플
- KB 토큰은 상세 B2C 명세의 `dataHeader` + `dataBody.{appKey,appSecret,grantType}`를 사용합니다. 간략 개발가이드의 평면 JSON 예시와 다릅니다.
- 현금 일반주문: 정규장 지정가/시장가 매수·매도, KRX 장전/장후 시간외 종가. 신용·공매도·정정/취소는 이번 추가 범위에 없습니다. 미체결 화면은 기존과 동일하게 준비 중입니다.
- NH 관리자 키의 실제 삼성전자 차트 조회 성공. KB는 관리자/개인 키가 없어 공식 샘플과 모의 응답 기반 검증이며 실제 접수·체결 검증은 하지 않았습니다.
