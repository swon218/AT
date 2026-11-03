# 헤르메스 전달문 · 환율 API 추가

ATLAS의 `main`에서 이 문서를 포함한 `환율api추가` 커밋을 배포하세요. 전달받은 SHA와 아래 명령의 결과를 대조하세요.

```bash
git log -1 --format='%H %s' -- deploy/EXCHANGE_RATE_HERMES.md
```

1. 실제 Node API 서비스 이름, 작업 디렉터리, 실행 사용자와 환경파일 경로를 확인하세요. `atlas-api.service`는 기존 배포 기준 이름입니다.

   ```bash
   systemctl show atlas-api.service -p WorkingDirectory -p User -p EnvironmentFiles
   ```

2. 서비스 환경에 기존 관리자 `TOSS_API_KEY`와 `TOSS_SECRET_KEY`가 설정됐는지 확인하세요. 기존 소문자 별칭도 지원합니다. 값 대신 설정 여부만 보고하세요. 토스증권에 등록된 IP와 VPS의 실제 외부 송신 IP를 대조하고 해당 키의 환율 조회 권한을 확인하세요. 로컬 토큰 발급은 HTTP 403이었으며 응답 코드와 설명이 공식 명세의 허용 IP 차단 예시와 일치했습니다. VPS의 등록 상태와 실제 환율 조회 성공 여부는 운영에서 확인하세요.
3. 실제 작업 디렉터리에서 저장소 소유자로 아래 명령을 실행하세요. 작업 트리에 변경이 있으면 보존하고, 단계 실패 시 후속 작업을 중단하세요.

   ```bash
   git status --short
   git pull --ff-only origin main
   git log -1 --format='%H %s' -- deploy/EXCHANGE_RATE_HERMES.md
   node --test server/exchangeRate.test.js
   sudo systemctl restart atlas-api.service
   systemctl is-active atlas-api.service
   ```

4. 기존 포트에 맞춰 공개 API를 호출하세요. 정상 응답은 양수 `midRate`, USD→KRW, 토스증권 출처, `validFrom`·`validUntil`·`receivedAt`을 반환합니다. 유효 시간 안에서는 `stale: false`를 확인하세요.

   ```bash
   curl -sS -w '\nHTTP %{http_code}\n' 'http://127.0.0.1:3000/api/public/market/toss/exchange-rate'
   ```

5. 60초 이내 반복 조회에서 `receivedAt`이 동일한지, 60초 경과 후 조회에서는 `receivedAt`과 원천 유효 구간이 갱신되는지 확인하세요. 환율 숫자가 같아도 시각이 갱신되면 정상입니다. 캐시 60초 이내 원천 유효 구간이 먼저 끝나면 다음 수신까지 갱신 지연으로 표시됩니다. 처음부터 조회할 수 없으면 HTTP 503과 `midRate: null`을 반환합니다. 오류 시 서비스 로그의 `status`·`stage`·`reason`만 보고하세요.
6. 같은 커밋을 포함한 Vercel 프런트엔드 배포를 확인하세요. 대시보드에서 1 USD당 원화 금액이 소수 둘째 자리로 표시되는지 확인하고, 네트워크 도구로 열린 탭에서 약 60초 간격의 GET과 탭 복귀 시 즉시 요청을 확인하세요. 모바일에서는 환율과 출처, KST 기준 시각이 모두 읽히는지 확인하세요.

이번 배포는 기존 의존성과 토스 관리자 설정을 사용합니다. VPS 적용 SHA, Node 서비스 상태, 실제 토스 API 응답 상태, 60초 갱신 확인 결과, Vercel 배포 SHA와 미확인 항목을 보고하세요.
