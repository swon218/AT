# VPS 헤르메스 전달문 — 검색 개선

ATLAS 저장소 `https://github.com/swon218/AT`의 `main`에 올라온 `검색 개선` 커밋을 VPS API에 반영해 주세요. 프런트엔드와 API가 함께 바뀌므로 VPS API를 먼저 반영하고 Vercel 프런트엔드 배포도 확인해 주세요.

## 변경 내용

- 웹 진입 시 `/api/public/market/kiwoom/catalog`에서 코스피·코스닥 전체 종목명/코드/시장 목록을 받아둡니다.
- `s` 한 글자부터 브라우저에서 즉시 검색합니다. `s → sk → sk하이닉스` 입력마다 검색 API를 호출하지 않습니다. 대소문자·공백을 무시하고 부분일치와 종목코드를 지원합니다.
- 결과는 우선 50개를 표시하고 스크롤 또는 아래 방향키로 더 표시합니다. 선택한 뒤 최신 시세·차트를 조회합니다.
- 목록은 30분 기준으로 갱신하며, 갱신 중에는 마지막 정상 목록을 계속 사용합니다. 브라우저는 1분마다 갱신 필요 여부를 확인하고 실패하면 재시도합니다.
- 서버 시작 시 관리자 종목 목록을 미리 준비합니다. 관리자 공개 목록만 `data/stock-catalog.json`에 저장해 재시작 후 복원합니다. 개인 키·세션·계좌 데이터는 이 파일에 저장하지 않습니다.
- 일시적인 갱신 실패 시 최대 7일 이내의 정상 목록을 사용하며 화면에 갱신 대기 상태를 표시합니다. 정상 목록이 전혀 없는 최초 접속에서는 목록을 준비할 때까지 로딩 표시가 나올 수 있습니다.
- 기존 관리자/개인 키 선택과 로그인 인증을 유지합니다. 개인 키 목록은 서버 메모리에서 권한별로 분리하고, 브라우저 저장 목록도 사용자/키 설정 버전별로 구분합니다.

## 배포 절차

1. `atlas-api.service`의 실제 `WorkingDirectory`, 실행 사용자, 포트, 환경 파일 경로를 확인하세요. 환경 변수 값은 출력하지 마세요. 기존 `.env`와 사용자 키 암호화 키를 유지하세요.
2. 해당 저장소에서 `git status --short`를 확인하세요. 운영 측 변경이 있으면 덮어쓰지 말고 먼저 내용을 확인하세요.
3. 아래 명령을 순서대로 실행하고 실패 시 다음 단계로 진행하지 마세요.

```bash
git pull --ff-only origin main
git log -1 --oneline
npm ci
npm run test:search
npm run test:server
npm run build
sudo systemctl restart atlas-api.service
sudo systemctl is-active atlas-api.service
```

추가 패키지·환경 변수·Supabase SQL은 필요하지 않습니다. 서버가 `src/utils/stockSearch.js`를 함께 사용하므로 저장소 전체 소스를 반영하세요. `data/`는 Git에서 제외되며 런타임에 생성됩니다. 기존 실험실 데이터는 유지하세요. 서비스 실행 사용자가 `data/`에 파일을 생성·교체할 수 있는지 확인하세요. 서비스 파일에 쓰기 경로 제한이 있다면 실제 저장소의 `data/` 경로를 기존 허용 범위에 맞게 설정하세요. 스냅샷 저장 실패는 검색 자체를 중단하지 않지만 재시작 후 복원이 되지 않으므로 경고를 확인하세요.

## 읽기 전용 검증

실제 서비스 포트에 맞춰 `api_base`를 설정하세요. 아래 예시는 기본 포트 3000입니다.

```bash
api_base=http://127.0.0.1:3000
curl --fail --silent "$api_base/api/health"
curl --fail --silent "$api_base/api/public/market/kiwoom/catalog" | node -e '
let raw = "";
process.stdin.on("data", chunk => raw += chunk);
process.stdin.on("end", () => {
  const value = JSON.parse(raw);
  const stock = value.items?.find(item => item.code === "000660");
  if (!value.items?.length || stock?.name !== "SK하이닉스") process.exit(1);
  console.log({ count: value.items.length, updatedAt: value.updatedAt, stale: value.stale, stock });
});'
curl --fail --silent "$api_base/api/public/market/kiwoom/search?q=s" | node -e '
let raw = "";
process.stdin.on("data", chunk => raw += chunk);
process.stdin.on("end", () => {
  const value = JSON.parse(raw);
  if (!value.items?.length || !value.items.every(item => /s/i.test(item.name))) process.exit(1);
  console.log({ total: value.total, shown: value.items.length });
});'
```

검색 결과의 상위 50개 구성은 종목 증감에 따라 바뀔 수 있습니다. 배포 당시 로컬에서 실제 목록 4,307개, `s` 부분일치 654개를 확인했으며 운영 시점의 숫자가 정확히 같을 필요는 없습니다.

`data/stock-catalog.json` 생성과 서비스 재시작 후 목록 복원을 확인하세요. API 응답은 `Cache-Control: private, no-store`가 정상입니다. 검색 가속은 서버/브라우저의 내부 목록 캐시로 처리하며, 개인 응답을 CDN 공용 캐시에 저장하지 않습니다.

Vercel의 해당 커밋 배포가 성공했는지 확인하고, 실제 웹에서 다음을 확인하세요.

- 목록 준비 후 `s` 입력 즉시 결과가 표시되고 `sk`, `sk하이닉스`로 좁혀집니다. `하이닉스`, `000660`, `삼`도 확인하세요.
- 입력을 바꿔도 결과가 로딩 문구로 교체되지 않으며, 개발자 도구 Network에서 글자마다 `/search?q=...` 요청이 발생하지 않습니다. `/catalog`는 진입/갱신 시 사용합니다.
- 많은 결과를 아래로 스크롤하면 50개 이후도 표시됩니다. 방향키 이동·Enter 선택·Esc 닫기가 작동하고 SK하이닉스 선택 시 해당 시세·차트가 열립니다.
- 새로고침 후에도 검색이 작동합니다. 로그인/로그아웃/개인 키 설정 변경 시 이전 권한의 진행 중 응답이 새 화면에 섞이지 않아야 합니다.

테스트 주문은 보내지 마세요. 보고할 내용은 적용 커밋, 서비스 상태, 목록 건수/갱신 시각, 스냅샷 저장·복원 여부, Vercel 배포 상태, 한 글자 검색 및 입력 중 네트워크 요청 확인 결과, 미확인 항목입니다.
