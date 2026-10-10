# 대시보드 지수 차트 배포

대시보드의 종목 연동 차트를 코스피·코스닥 지수 차트로 교체한다.
시장 순위 / 관심종목과 주문 화면의 종목 차트는 유지한다.

## 필요한 작업

- GitHub main에 연결된 Vercel 프런트엔드 배포와 별도로 **VPS 코드 업데이트 및 API 서비스 재시작**이 필요하다.
- 기존 키움 App Key/Secret 및 네이버 검색 API 키를 그대로 사용한다. 새 API 서비스 신청이나 환경변수 추가는 없다.
- 키움에는 API를 호출하는 **VPS의 공인 IP**가 등록돼 있어야 한다. PC IP 등록으로 VPS 등록이 대체되지는 않는다.
- Supabase 테이블, SQL, RLS, 사용자 설정 변경은 없다. Python/SQLite 및 실험실 수집 서비스·타이머도 변경하지 않는다.

기존 설치 경로 `/opt/atlas`, 저장소 소유자 `atlas`, 서비스 `atlas-api.service` 기준이다.
먼저 `git status --short`를 확인하고 로컬 변경이 있다면 보존한 뒤 진행한다.

```sh
cd /opt/atlas
git status --short
sudo -u atlas git pull --ff-only origin main
npm run test:server
sudo systemctl restart atlas-api.service
sudo systemctl status atlas-api.service --no-pager
curl --fail 'http://127.0.0.1:3000/api/public/market/kiwoom/indices?symbol=kospi&period=1d'
curl --fail 'http://127.0.0.1:3000/api/public/market/kiwoom/indices?symbol=kosdaq&period=1y'
curl --fail 'http://127.0.0.1:3000/api/public/news/dashboard?category=all'
```

실제 API 포트가 다르면 기존 포트를 사용한다. 의존성 추가는 없어 npm 패키지 설치는 필요 없다.
운영 API를 먼저 업데이트하고, Vercel이 같은 커밋으로 배포됐는지 확인한다.

## 동작 및 확인

- 지수: `kospi` / `kosdaq`. 기간: `1d`, `1w`, `1m`, `3m`, `1y`.
- 1일: 최근 거래일의 1분봉. 나머지 기간: 마지막 거래일부터 해당 달력 기간의 일봉. 휴장일에도 최근 거래일이 표시된다.
- 현재 지수 `ka20001`, 분봉 `ka20005`, 일봉 `ka20006`. 차트 지수 100배 및 거래량 천주 단위를 정규화한다.
- 30초 갱신 및 사용자/키 버전별 서버 캐시. 비로그인 또는 개인 키 미등록 시 관리자 키, 개인 키 등록 시 해당 사용자 키를 사용한다. 개인 키 오류를 관리자 키로 숨기지 않는다.
- 순위에서 종목을 선택해도 지수 선택은 바뀌지 않는다. 주문 화면의 종목 차트는 기존 기능을 유지한다.
- 뉴스: 전체/시장/종목/경제/해외/공시. 네이버 뉴스 검색 응답을 제목·요약 기반으로 분류하며 5분마다 갱신한다.
- **공시 탭은 공시 관련 보도이며 DART/KIND의 공시 원문 피드가 아니다.** 별도 DART 키는 필요 없다.
- 속보는 원본 기사 제목에 속보가 있는 경우에만 표시하며, 태그에는 기사에서 확인한 주제만 사용한다. 주가나 등락률을 임의로 생성하지 않는다.
- 브라우저에서 두 지수와 모든 기간 전환, 뉴스 분류/기사 원문/더보기 링크, 좁은 화면 배치를 확인한다.

이번 변경의 로컬 검증과 운영 배포 완료는 별개다. 운영 서버 업데이트 후 위 HTTP 경로가 200 및 실제 데이터를 반환하는지 확인한다.
