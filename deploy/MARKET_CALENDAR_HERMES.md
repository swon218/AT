# 헤르메스 전달문 · 장 상태 개선

ATLAS `main`에서 이 문서를 포함한 `장 상태 개선` 커밋을 적용하세요. 전달받은 SHA와 `git log -1 --format='%H %s' -- deploy/MARKET_CALENDAR_HERMES.md`의 결과를 대조하세요.

1. 실제 Node API 서비스 이름, 작업 경로, 실행 사용자와 환경파일 경로를 확인하세요. 아래 서비스명은 기존 운영 기준입니다.

   ```bash
   systemctl show atlas-api.service -p WorkingDirectory -p User -p EnvironmentFiles
   ```

2. 기존 관리자 `TOSS_API_KEY`와 `TOSS_SECRET_KEY` 또는 기존 소문자 별칭의 설정 여부를 확인하세요. 키, 토큰, 환경파일 내용은 출력하지 마세요. VPS의 실제 외부 송신 IP를 토스증권 허용 IP와 대조하고 캘린더 조회 권한을 확인하세요. 로컬은 토큰 발급 단계에서 HTTP 403을 받았고 코드와 설명이 공식 허용 IP 차단 예시와 일치했습니다.
3. 실제 작업 경로에서 저장소 소유자로 진행하세요. 작업 트리의 기존 변경을 보존하고 명령이 실패하면 이후 단계는 중단하세요.

   ```bash
   git status --short
   git pull --ff-only origin main
   git log -1 --format='%H %s' -- deploy/MARKET_CALENDAR_HERMES.md
   TZ=America/New_York node --test server/marketCalendar.test.js server/marketSession.test.js server/exchangeRate.test.js
   sudo systemctl restart atlas-api.service
   systemctl is-active atlas-api.service
   ```

4. 실제 포트에서 공개 API를 확인하세요. 정상 응답에 한국 기준 `date`, `serverNow`, `fetchedAt`, `currentSession`, `nextSession`, `transitionAt`, `stale`가 있는지 확인하세요. 장애 시 HTTP 상태와 로그의 `status`, `stage`, `reason`만 보고하세요.

   ```bash
   curl -sS -w '\nHTTP %{http_code}\n' 'http://127.0.0.1:3000/api/public/market/session'
   ```

5. 운영 서비스와 같은 환경에서 기존 `requestToss`를 통해 `GET /api/v1/market-calendar/KR`을 읽기 전용으로 확인하세요. 오늘은 KST 날짜를 `date`로 보내고 `today.date`가 일치하는지, `integrated`의 세 세션과 다음 거래일 첫 세션이 공개 API 안내와 일치하는지 확인하세요. 평일 휴장 예시 `2026-05-05`와 주말 날짜의 요청이 허용되면, 응답의 `today.date`와 명시적 `integrated: null`을 확인하세요. 과거 날짜가 조회 범위를 벗어나면 다음 실제 휴장일에 확인하세요. 날짜 불일치나 누락 응답을 받으면 휴장으로 판정하지 않습니다.
6. 세션 경계 직전·직후를 비교해 같은 `fetchedAt`의 캐시 일정에서도 서버 상태가 바뀌는지 확인하세요. KST 23:59와 00:00 이후에는 `date`가 바뀌고 새 날짜 일정으로 조회되는지 확인하세요. 다음 거래일 안내는 `nextBusinessDay`의 첫 유효 세션과 대조하세요.
7. 같은 커밋을 포함한 Vercel 배포에서 장 상태 카드와 기존 환율을 확인하세요. 장 상태 요청은 `/api/public/market/session`으로 진입 시 즉시, 열린 탭에서 약 30초마다, 그리고 `transitionAt`과 탭 복귀 시 발생합니다. 카드에서 기존 키움 장 상태 경로를 요청하지 않는지 확인하세요. 휴장일에는 ‘휴장’, 장애로 당일 일정이 없을 때는 ‘장 상태 확인 불가’를 확인하세요.

로컬에서는 빌드와 모의 일정 검증을 완료했습니다. 실제 캘린더의 정상·휴장 응답과 운영 배포는 VPS에서 확인해야 합니다. API와 웹의 배포 SHA, 서비스 상태, 실제 캘린더 응답, 한국 날짜 변경, 세션 전환과 휴장 표시 결과를 각각 보고하세요.

[토스증권 공식 OpenAPI 명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)
