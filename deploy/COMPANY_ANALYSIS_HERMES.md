# 기업 분석 운영 반영

이 커밋은 Vercel 프런트와 VPS의 `atlas-api.service`를 함께 사용합니다. 작업 기준 SHA는 사용자에게 전달된 `기업 분석 데이터 연결`의 전체 해시입니다. `main`을 fetch하고 해당 해시와 변경 범위를 확인하세요. 기존 Vercel의 `VITE_API_BASE_URL`과 서버의 CORS 설정을 사용합니다. 새 프런트가 먼저 배포되면 구 API에 대해 기업정보 서비스 미배포 안내를 표시합니다.

1. ATLAS가 사용하는 Supabase 프로젝트에서 관리자가 `deploy/COMPANY_ANALYSIS_SUPABASE.sql`을 먼저 실행했는지 확인하세요. 마지막 두 확인 쿼리에서 5개 테이블의 RLS가 켜지고 브라우저 역할의 직접 읽기·쓰기가 거부되며 `service_role`만 읽기와 RPC 실행이 가능해야 합니다. 확인되지 않으면 API 반영을 보류하세요.
2. `systemctl show atlas-api.service -p WorkingDirectory -p User -p EnvironmentFiles`로 운영 경로를 확인하세요. 서버 환경파일에 `OpenDart_api_key`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`가 설정돼 있어야 합니다. 값은 출력하지 말고 VPS의 승인된 비밀 관리 경로로 설정하세요. 프런트 환경에 비밀값을 추가하지 마세요.
3. 운영 체크아웃에서 clean 상태, 이전 SHA와 대상의 조상 관계를 확인하세요. `git fetch origin main`, `git merge-base --is-ancestor HEAD "$DEPLOY_SHA"`, `git diff --name-status HEAD "$DEPLOY_SHA"` 순서로 검토하고 `git merge --ff-only "$DEPLOY_SHA"`를 실행하세요. SHA와 diff가 확인 범위를 벗어나면 작업을 중지하세요. 새 의존성이 없으므로 기존 Node 의존성을 사용하고 `node --test server/companyDart.test.js`는 개발 의존성이 있는 별도 체크아웃에서 실행하세요.
4. 운영 unit의 사용자·환경파일·작업 경로를 사용해 `node deploy/company_dart.js sync-codes`를 한 번 실행하세요. 예시는 `sudo systemd-run --wait --pipe --collect -p User=atlas -p WorkingDirectory=/opt/atlas -p EnvironmentFile=/etc/atlas/atlas.env /usr/bin/node /opt/atlas/deploy/company_dart.js sync-codes`입니다. 초기 실행이 정상인지 보고한 후 같은 방식으로 `verify 005930`을 한 번 실행하세요. 첫 조회, 저장, 새 인스턴스 재조회 상태와 시각을 확인하고 키나 제공처 원문은 출력하지 마세요.
5. `atlas-api.service`만 재시작하세요. `/api/health` 200, 비로그인 `/api/public/company/005930?section=overview`의 200과 보고기간·출처 표시, 잘못된 날짜 요청의 400을 loopback과 기존 외부 API에서 확인하세요. 운영 브라우저에서 기업 분석의 공시·재무 화면을 대표 기업 하나로 확인하고, Vercel Production의 배포 SHA와 운영 도메인도 대조하세요. 기존 계좌 경로의 비인증 401과 실험실·AI 서비스 상태를 확인하세요.
6. 이상이 없으면 실제 운영 사용자·경로·환경파일을 확인한 후 `deploy/atlas-dart-refresh.service`와 `.timer`를 `/etc/systemd/system/`에 설치하세요. `systemd-analyze verify` 후 `systemctl daemon-reload`, `systemctl enable --now atlas-dart-refresh.timer`를 실행하세요. `systemctl list-timers atlas-dart-refresh.timer`, `journalctl -u atlas-dart-refresh.service -n 30 --no-pager`에서 제한된 수집과 상태만 확인하세요. 타이머의 15분 단위 실행, DB 선점 및 일일 호출 상한이 중복을 제어합니다.
7. 이상 시 `systemctl disable --now atlas-dart-refresh.timer`로 예약을 끄고 `systemctl stop atlas-dart-refresh.service`로 실행 중인 갱신을 중지하세요. 배포 전 기록한 정상 VPS SHA를 기존 절차로 다시 배치하고 `atlas-api.service`만 재시작해 health와 기존 API를 확인하세요. 프런트도 직전 정상 Vercel Production 배포로 되돌리세요. 새 Supabase 테이블과 수집 데이터는 보존하세요.

## 저장·갱신 정책

- `DART_DAILY_LIMIT` 기본 500회, 최대 10,000회. KST 날짜와 Supabase 트랜잭션 기준입니다. `DART_PUBLIC_PER_MINUTE` 기본 90회는 API가 식별하는 IP별 상한이며 전체 상한은 그 5배입니다. 역방향 프록시가 모두 동일 IP로 보이면 IP 상한을 공유합니다.
- `DART_PROFILE_TTL_SECONDS` 86,400초. 고유번호 전체 목록은 하루에 한 번 확인하며, 기업 상세는 조회된 기업만 수집합니다. 미매핑 종목은 회사명으로 추정하지 않습니다.
- `DART_DISCLOSURE_TTL_SECONDS` 900초, `DART_HISTORY_TTL_SECONDS` 604,800초. 최근 공시는 겹치는 접수일 범위를 다시 조회하고 접수번호로 upsert합니다. 과거 검색 범위도 만료되면 다시 검사합니다. 공시는 포함 범위 최대 366일, 30건씩 최대 100페이지를 제공합니다.
- `DART_REPORT_TTL_SECONDS` 86,400초. 최신 정기공시와 정정본은 원 접수번호 및 기간 계열을 유지합니다. 새 접수번호의 재무자료를 다시 수집하며 검증된 동일 접수번호의 재무자료는 최대 365일 재사용합니다. 사업보고서 원문 추출은 사업·성장 진입 시 수집합니다.
- 만료 자료는 기존 정상 스냅샷을 표시합니다. 수집 작업은 DB에서 최대 2개를 선점하고 3분이면 선점이 만료됩니다. 제공처 요청은 12초, 작업은 최대 140초 기준이며 실패는 작업별 지수 백오프를 적용합니다. 테스트에서 운영 Supabase를 사용하지 않습니다.
- 원문 ZIP은 최대 24MiB, 선택 XML은 최대 32MiB까지만 메모리에서 처리합니다. 원문을 별도 저장하지 않고 공시 접수번호와 파서 버전이 있는 텍스트만 보존합니다. 파서를 수정한 뒤 운영 DB 관리자가 해당 기업의 `kind='business'` 작업의 `expires_at`을 현재 시각으로 바꾸면 다음 제한 갱신에서 원문을 다시 처리합니다. 정상 추출물은 새 결과가 저장될 때까지 유지됩니다.

## 제공 범위

| 유형 | 내용 |
| --- | --- |
| 직접 제공 | 고유번호·기업개황, 공시 페이지·접수번호, 연결/별도 표준 계정, 최대주주, 주식 종류별 연간 현금배당, 대량보유, 최신 연간 감사의견 |
| 계산 | 전년 동기 증가율, 영업이익률, 연간 전체 순이익과 평균 총자본을 사용한 ROE, 유형자산 취득 현금 유출을 사용한 설비투자·잉여현금흐름 |
| 원문 | 사업의 개요·제품·서비스·수주·연구개발에서 정확한 제목을 가진 문단을 발췌합니다. 표 항목별 정량 수치는 미확인으로 두고 원문을 표시합니다. 전망, IR, 자사주 및 소송·조달은 공시 제목과 원문을 제공하며 완료 여부를 추론하지 않습니다. |
| 제한 | 동일한 회계기준과 정정 상태를 증명할 수 없는 Q4 손익·분기 현금흐름 누적 차감은 비워 둡니다. 가격 의존 지표, 컨센서스·목표주가와 전체 IR 자료는 별도 데이터가 필요합니다. |
