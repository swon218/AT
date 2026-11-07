# VPS 헤르메스 전달문 · 사용자 API 범위

대상은 `https://github.com/swon218/AT`의 `main`, 커밋 제목 **`사용자 API 범위`**입니다. 전달받은 최종 전체 SHA를 `DEPLOY_SHA`에 넣고 대조하세요. `main` 기준은 `deploy/MAIN_RESTORE_HERMES.md`를 따릅니다. 과거 선별 브랜치 고정 지침은 적용하지 않습니다.

## 변경 범위

- Node API에 `GET /api/account/connections/{kiwoom,toss,nh,kb}` 네 경로와 개인 키 삭제 처리를 추가했습니다. 인증 세션으로 사용자를 식별하고 기존 암호화 저장 경로를 사용합니다.
- 연결 성공 증거: 키움 `kt00001`의 명시적 성공 코드와 숫자 `entr`; 토스의 새 `/api/v1/accounts` 응답에서 유효한 `BROKERAGE` 계좌의 필수 필드; NH `/n2/acctinfo`에 귀속된 환경에 맞는 계좌로 `/krstock/inquiry/v1/balance` 첫 페이지의 숫자 `dca` 또는 유효한 보유종목 행; KB `ssqm2952`의 정상 업무 봉투와 숫자 `dy_tfnd`입니다. 0원은 성공, 업무 오류·빈 응답·필수 증거 누락은 실패입니다.
- 사용자·증권사·자격증명 해시별 60초 메모리 캐시와 진행 중 호출 합치기, 증권사별 전체 검증 제한 12초를 사용합니다. 키 저장·교체·삭제는 해당 캐시를 무효화합니다. 브라우저는 검증 중 성공을 표시하지 않으며 탭 이동으로 재조회하지 않습니다.
- 브라우저 응답은 `connected`와 `expiresAt`뿐입니다. 키·토큰·계좌번호·잔고·원문 오류를 반환하거나 기록하지 않습니다. 새 연결 경로는 요청 로그를 끕니다.
- `*Configured`는 저장 여부이며 주문 권한·서버 주문 검증은 바꾸지 않았습니다. 실주문·취소 테스트는 하지 않습니다.

## VPS 적용

1. `atlas-api.service`의 실제 WorkingDirectory·실행 사용자·unit 경로와 현재 SHA를 확인하세요. `systemctl show atlas-api.service -p WorkingDirectory -p User -p FragmentPath`만 사용하고 Environment/전체 환경파일/키·토큰을 출력하지 마세요. 실제 운영 checkout에서 실행하며 소유자와 기존 환경파일·venv·DB를 보존하세요.
2. `git status --short`가 깨끗한지 확인하고 적용 전 SHA와 branch/detached 상태를 별도로 기록하세요. 로컬 변경이 있으면 덮어쓰지 말고 중단·보고합니다. 최신 main을 무조건 배포하지 말고 전달받은 SHA로 고정합니다.

```bash
DEPLOY_SHA='<최종 보고의 사용자 API 범위 전체 SHA>'
PREVIOUS_SHA=$(git rev-parse HEAD)
git status --short
git fetch origin main
git show -s --format='%H %s' "$DEPLOY_SHA"
git merge-base --is-ancestor "$DEPLOY_SHA" origin/main
git merge-base --is-ancestor HEAD "$DEPLOY_SHA"
git diff --name-status HEAD "$DEPLOY_SHA"
```

각 확인이 성공해야 다음 단계로 진행하세요. 현재 HEAD가 대상의 조상이 아니거나 예상 외 변경이 있으면 강제 reset/merge하지 말고 차이를 보고하세요. API 변경은 `server/accountConnectionCache.js`, `server/accountConnections.js`, `server/accountSettings.js`, `server/tossClient.js`, `server/index.js`입니다. 나머지는 공통 프런트·모의 테스트·이 문서입니다. 대상 이전의 미반영 실행 코드가 발견되면 그 배포 범위를 먼저 확인하세요.

3. 기존 운영 checkout에서 현재 branch/detached 상태를 유지하며 fast-forward로 반영합니다. 의존성 파일 변경이 없고 새 패키지·SQL 마이그레이션·환경변수 변경이 없습니다. 기존 Node 의존성이 이미 설치돼 있다면 npm ci는 필요하지 않습니다.

```bash
git merge --ff-only "$DEPLOY_SHA"
test "$(git rev-parse HEAD)" = "$DEPLOY_SHA"
node --test server/accountConnections.test.js tests/brokerConnections.test.js server/brokerSettings.test.js server/addedBrokers.test.js
npm run test:server
npm run build
sudo systemctl restart atlas-api.service
sudo systemctl is-active atlas-api.service
```

각 명령 실패 시 다음 명령을 진행하지 마세요. **재시작 대상은 `atlas-api.service` 하나입니다.** `atlas-ai`·수집 unit/timer·실험실 DB·Python 환경·암호화 키·기존 주문 활성화 설정은 변경하지 마세요. KB의 기존 `KB_CLIENT_IP`/`KB_CLIENT_MAC` 설정이 없으면 KB 연결은 실패합니다. 비밀값 없이 설정 여부만 확인하고 임의 값을 넣지 마세요.

## 운영 확인

실제 API 포트에 맞추고 로컬 loopback과 외부 API origin 모두에서 확인합니다. 운영 origin은 기존 설정을 사용하며 키나 세션을 URL에 넣지 마세요.

```bash
API_ORIGIN='http://127.0.0.1:3000'
curl --silent --output /dev/null --write-out 'health=%{http_code}\n' "$API_ORIGIN/api/health"
for broker in kiwoom toss nh kb; do
  curl --silent --output /dev/null --write-out "$broker guest=%{http_code}\n" "$API_ORIGIN/api/account/connections/$broker"
  curl --silent --output /dev/null --header 'Authorization: Bearer invalid-verification-session' --write-out "$broker invalid=%{http_code}\n" "$API_ORIGIN/api/account/connections/$broker"
done
```

health는 200, 네 경로의 무인증·유효하지 않은 인증은 모두 401이어야 합니다. 인증 없음에 200 또는 SPA HTML이 오면 완료로 보고하지 마세요. 기존 역방향 프록시의 `/api/account/` 라우팅을 확인하고, 이 경로가 차단된 경우에만 해당 location에 최소 수정 후 설정 검증·reload를 진행합니다. 사용자 인증 요구를 제거하지 마세요.

로그·응답 원문·Authorization·토큰·키·계좌번호·잔고·브라우저 저장소를 복사하거나 보고하지 마세요. 상태 확인은 서비스 active 여부, HTTP 상태, 표시용 두 필드의 스키마, 증권사별 연결 참/거짓만 기록합니다. journald 원문을 채팅에 붙이지 마세요. 이 기능의 검증을 위해 환경파일을 cat하거나 사용자 토큰을 추출하지 마세요.

본인 세션을 사용할 수 있는 사용자가 웹에서 확인합니다. 신규 사용자는 전부 연결안됨/사용불가, 정상 4곳은 전부 연결됨/사용가능, 한 곳 오류는 그곳만 연결안됨/일부 사용이어야 합니다. 7개 탭 이동으로 표시나 호출 수가 바뀌지 않아야 하며, 60초 만료 후에는 재검증 중 성공이 숨겨집니다. 키 교체·삭제·로그아웃·다른 사용자 로그인에서 이전 성공이 돌아오면 실패입니다. NH 검증으로 기존 주문용 선택 계좌가 바뀌지 않아야 합니다. 정상 0원 계좌도 확인 대상입니다. 실주문·취소를 보내지 마세요.

본인 실제 키로 위 검증을 하지 못하면 **개인 실연결 미검증**으로 남깁니다. 로컬 모의 검증을 실연결 성공으로 보고하지 마세요. 모의 웹 재현은 개발용 별도 checkout에서 `node tests/brokerConnectionsBrowserHarness.mjs`를 실행하고 `http://127.0.0.1:15177/tests/brokerConnections.html`을 엽니다. 운영 서비스로 이 모의 서버를 실행하거나 외부에 공개하지 마세요.

## Vercel과 복구

- 프런트는 main의 **동일 DEPLOY_SHA**가 Vercel Production으로 Ready인지, 운영 도메인이 그 배포를 가리키는지 별도로 확인합니다. Preview만으로 완료 처리하지 않습니다. 기존 `VITE_API_BASE_URL`, 인증 설정·도메인은 유지합니다. GitHub push·VPS 재시작·로컬 빌드는 Vercel 운영 반영의 증거가 아닙니다.
- API 적용·기동·401 확인에 이상이 있으면 운영 checkout이 여전히 깨끗한지 확인하고 기록한 `PREVIOUS_SHA`로 `git switch --detach "$PREVIOUS_SHA"` 후 `atlas-api.service`만 재시작합니다. health·401·active를 재확인하고 원래 branch/detached 상태와 두 SHA를 보고합니다. 강제 reset·원격 force push·DB 복구·키 교체는 하지 마세요. 프런트에서 새 기능이 이미 배포됐다면 Vercel도 기록된 직전 정상 Production 배포로 복구합니다.
- 보고: 대상/이전/VPS 실행 SHA, 서비스 active, 네 경로의 무인증·잘못된 인증 HTTP 상태, 응답·로그 비밀값 미노출 여부, 사용자별 읽기 전용 실제 확인 범위, Vercel Production SHA·배포 ID·도메인, 미검증 사항, 복구 수행 여부를 구분해 주세요.
