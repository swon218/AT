# 헤르메스 전달문 — 뉴스 탭 추가

저장소: `https://github.com/swon218/AT`, 브랜치: `main`.
배포 대상은 **이 문서를 포함하는 `뉴스 탭 추가` 커밋**입니다. 전달받은 SHA와 대조하세요. 이 문서 자체에 자기 커밋 SHA를 기록하지 않으므로, 저장소에서 `git log -1 --format='%H %s' -- deploy/NEWS_TAB_HERMES.md`로 확인할 수 있습니다.

## 적용 사항

- 사이드바 `주요 뉴스 · 공시`와 대시보드 더보기가 같은 내부 페이지로 이동합니다. 더보기는 선택 분류를 전달합니다.
- 대시보드는 최대 6건 미리보기, 전용 페이지는 검색 결과를 50개씩 조회합니다. 원본 위치 `nextStart`를 이용하며 분류·중복 제거 후 표시 건수와 구분합니다.
- 새 공개 경로: `GET /api/public/news/feed?category=all&start=1&display=50`. 분류는 `all/market/stock/economy/overseas/disclosure`, start는 정수 1~1000, display는 정수 1~100입니다.
- 네이버 문서의 display 최대 100, start 최대 1000 범위 안에서, 이 페이지는 검색 결과 1~1000까지 제공합니다. 마지막 요청은 남은 범위만 조회합니다. `nextStart: null`, `endReason: end/limit`로 종료를 구별합니다.
- 기존 `/api/public/news`와 `/api/public/news/dashboard` 응답을 유지합니다. 캐시는 검색어·개수·위치별 5분이며 동시 동일 요청을 공유합니다.
- 브라우저는 원문 우선 http/https 링크만 새 탭으로 엽니다. 공시는 네이버 공시 관련 뉴스이며 DART 공식 목록이 아닙니다.

## VPS 적용

Node 서버 코드가 변경되므로 **API 서비스 재시작이 필요합니다. 프런트엔드만 배포하면 새 목록 API가 없어 실패합니다.**

1. 실제 서비스와 작업 경로를 확인하세요. 아래 `atlas-api.service`, `/opt/atlas`, 포트 3000은 기존 문서의 예시입니다. 현재 설정을 우선하고 환경파일·키 값은 출력하지 마세요.

```bash
systemctl show atlas-api.service -p WorkingDirectory -p User -p Group -p EnvironmentFiles
```

2. 실제 저장소 경로에서 로컬 변경을 확인하고 보존하세요. 변경이 있거나 명령이 실패하면 다음 단계로 진행하지 마세요. 기존 저장소 소유자로 실행합니다.

```bash
cd /opt/atlas
git status --short
git pull --ff-only origin main
git log -1 --format='%H %s' -- deploy/NEWS_TAB_HERMES.md
npm run test:news
sudo systemctl restart atlas-api.service
sudo systemctl is-active atlas-api.service
```

의존성 추가가 없어 이번 변경을 위한 npm 설치는 필요 없습니다. 기존 네이버 서버 키와 CORS/도메인 설정을 사용합니다. SQL·환경변수 변경·Python/AI/수집기/WAL 서비스 재시작은 필요하지 않습니다.

3. 현재 API 포트에 맞춰 인증 없이 조회하세요. 실제 응답의 다음 위치를 사용해 요청하고, 표시 건수에 1을 더해 다음 start를 만들지 마세요.

```bash
curl --fail 'http://127.0.0.1:3000/api/public/news/dashboard?category=all'
curl --fail 'http://127.0.0.1:3000/api/public/news/feed?category=disclosure&start=1&display=50'
curl --fail 'http://127.0.0.1:3000/api/public/news/feed?category=disclosure&start=51&display=50'
curl --fail 'http://127.0.0.1:3000/api/public/news/feed?category=all&start=1000&display=50'
```

첫 요청이 50개 검색 결과를 수신한 경우 두 번째 위치는 51입니다. 첫 구간에서 끝났다면 추가 요청할 필요 없습니다. 분류 필터 때문에 items가 0이어도 nextStart가 있으면 추가 조회 가능합니다. start=1000에서는 최대 1개 검색 결과만 조회하며 nextStart가 null이어야 합니다. 잘못된 category/start/display는 400이어야 합니다.

## 프런트엔드와 운영 확인

API 적용 후 같은 커밋이 포함된 Vercel 프로덕션 배포를 확인하세요. 기존 `VITE_API_BASE_URL`을 유지하고, API 키를 VITE 변수로 옮기지 마세요. 프런트엔드를 VPS에서 직접 제공하는 경우에만 `npm run build` 후 기존 방식으로 dist를 배포하세요.

확인할 동작:

1. 로그아웃 상태에서 사이드바 메뉴명·활성 표시, 접힌 아이콘, 모바일 메뉴 진입 및 닫힘.
2. 대시보드 공시 → 더보기 → 공시가 선택된 전용 페이지. 로딩/빈 결과/오류에서도 더보기 가능.
3. 기사 클릭 → 제공된 언론사 원문 새 탭. 원문이 없으면 제공된 안전한 대체 링크.
4. 추가 조회 시 요청 start가 nextStart와 일치하고 기존 목록에 새 기사만 추가되는지 확인.
5. 분류 빠른 전환·실패 후 재시도·모바일 320/390px에서 가로 넘침 확인.
6. 5분마다 새 목록을 확인하되 기존 목록·페이지 위치를 자동 교체하지 않고, 새 목록 안내 후 사용자가 적용하는지 확인.

보고할 내용: 배포 커밋 SHA, VPS API 서비스 상태/재시작 시각, 새 API 실제 응답과 nextStart, Vercel 배포 커밋/성공 여부, 화면 확인 결과와 미확인 항목.

## 로컬 검증 기록 (2026-11-04)

- `npm run build` 성공. 기존 번들 크기 경고는 남아 있습니다.
- `npm run test:news` 16/16 통과. 분류/범위 검증, 실제 Fastify 공개 라우트, 조회 위치, 캐시 분리/5분 만료, 동시 요청 공유, 중복·URL, 빈 구간/종료/오류 재시도를 검증합니다.
- Chrome + 로컬 실제 네이버 API: 사이드바 직접 진입과 활성 상태, 대시보드 공시 분류 전달, 추가 조회 37 → 78건, 광주매일신문 원문이 별도 탭으로 열리는 동작을 확인했습니다. 이 건수는 당시 응답이며 운영 고정값이 아닙니다.
- 390px 및 320px에서 모바일 메뉴와 제목/분류/본문 배치를 점검했습니다. 뉴스 페이지의 기존 body 최소 너비에 따른 320px 가로 넘침을 수정했습니다.
- 테스트 전용 화면에서 오류·재시도, 빈 결과, 필터 후 0건이어도 다음 구간 조회, 지연된 이전 분류 응답 차단, 추가 조회 실패 시 목록 보존 및 같은 위치 재시도, 자동 갱신 시 기존 목록·조회 위치 유지/명시적 새 목록 적용을 확인했습니다.
- 자동 갱신을 예약한 뒤 목록을 스크롤해 확인한 결과, 읽던 13~18번 기사와 화면 내 위치가 유지됐습니다(측정 오차 1px 미만). 대시보드 로딩/오류/빈 결과에서도 더보기 이동을 확인했습니다.
- VPS/Vercel 실제 배포는 이 작업에서 수행하거나 완료로 검증하지 않았습니다. 1000개 경계와 캐시 만료는 테스트 응답/가상 시간으로 검증했으며, 실제 뉴스 API의 장시간 데이터 변화 및 모든 언론사 원문 접근 가능 여부를 전수 검사하지 않았습니다.

테스트 화면은 로컬 Vite에서 `/tests/newsBrowser.html`로 열 수 있습니다. 뉴스 응답을 브라우저 내 테스트 데이터로 대체하며 실제 API를 호출하지 않습니다. production 빌드 진입점에는 포함되지 않습니다. `응답 시나리오`, `5분 경과`, `5초 뒤 갱신 예약`, `요청 기록`으로 상태를 재현할 수 있습니다.

네이버 조회 범위 근거: [네이버 뉴스 검색 API 문서](https://developers.naver.com/docs/serviceapi/search/news/news.md).
