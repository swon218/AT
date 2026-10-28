# 조건 검색 구현 검증 (2026-10-28)

## SQLite/WAL 후속 검증

- `a7abb937`의 운영 배포는 사용자 보고상 gate 실패로 중단됐습니다. 아래 최초 로컬 통과 기록은 운영 통과 기록이 아닙니다.
- Ubuntu 22.04 시스템 Python 3.10.12 / SQLite 3.37.2의 공개 CI를 추가했습니다. 기존 47개는 동일 Linux CI에서 통과해, VPS의 네 가지 실패를 SQLite 버전만으로 단정하지 않습니다.
- 후속 v2는 main ctime/ACL, WAL 보존·삭제·메타데이터와 실제 commit을 구분합니다. 실제 commit, 같은 크기/mtime WAL commit, 데이터 교체·혼합 거부는 계속 검증합니다.
- 실제 서로 다른 비관리자 UID로, main DB/디렉터리에 쓰기 권한이 없는 reader가 WAL 부재 때 실패함을 재현했습니다. 기존 owner의 query-only guard가 준비한 뒤 같은 reader로 `SCREENER_READONLY_GATE_PASS`를 확인했고, 실제 writer commit 및 TRUNCATE checkpoint 후에도 다시 gate를 통과했습니다. helper/reader의 SQL 쓰기 차단과 기존 ACL mask 보존도 검증합니다.
- 최종 후보 CI 기록: https://github.com/swon218/AT/actions/runs/40701734113 (Linux 일반 51개 통과, 권한 분리 2개는 일반 실행에서 skip 후 별도 단계에서 2개 모두 실제 실행·통과). 총 53개 회귀 조건을 실제 Linux에서 확인했습니다. 공개 API는 읽기 인프라 실패를 빈 종목 목록이나 원문 예외로 노출하지 않고 503으로 반환합니다.
- Windows 격리 SQLite 3.37.2: 일반 50개 통과, Linux 전용 3개 skip(실제 UID 2개와 Windows mandatory WAL lock 때문에 fail-closed하는 미커밋 raw-read 1개). Node의 관련 실제 HTTP/프록시 테스트 6개 통과. 최초 변경의 Node 전체 121개/build 통과 기록은 아래에 별도로 보존합니다.
- 실제 운영 DB의 새 gate와 새 owner-side 보조 서비스 반영은 여전히 VPS 작업입니다. 후속 배포는 `deploy/SCREENER_SQLITE_HERMES.md`가 이전 지침보다 우선합니다. SQLite 업그레이드, DB 복제, 수집 스케줄·품질 변경, AI 쓰기 권한 추가, 운영 유료 호출은 하지 않았습니다.

## 확인한 범위

- 새 탭은 실험실과 AI 에이전트 사이에 위치하며, 공통 sidebar footer와 header를 그대로 사용합니다.
- Chrome 로컬 UI에서 수동 RSI 검색, 실제 수치/조건 값 표시, RSI+이동평균선 조건 조합, 조건 변경 시 결과 초기화, AI 질문 초안 생성, fixture 모델의 `screen_stocks` 실행, 저장된 AI 결과에서 조건을 다시 여는 동작을 확인했습니다.
- 작은 화면에서는 조건 입력/결과가 한 열로 배치되며 페이지 가로 넘침이 없는 것을 확인했습니다. 임시 viewport 설정은 원복했습니다.
- Python 전체 47/47 통과: 격리 SQLite 3.37.2. 이 런타임은 프로젝트의 무시된 로컬 캐시에서만 사용하며 시스템/VPS SQLite는 변경하지 않았습니다.
- Node 전체 121/121 통과: 기존 API/주문/계좌/검색/대화 테스트와 새 프록시·조건검색 HTTP 통합. 외부 증권사/LLM 호출은 fixture입니다.
- Vite production build 성공. 기존과 같은 번들 크기 경고는 남습니다.
- Python 수치 계산을 기존 JS 실험실 차트와 비교했습니다. SMA/EMA/RSI/볼린저/평균 거래량/MACD 전 시계열의 값과 워밍업 위치가 일치합니다(허용 오차 1e-10).
- 읽기 전용 품질·snapshot gate는 실제 lab 스키마의 fixture DB로 검증했습니다. 실제 외부 WAL commit 시 캐시 무효화, 격리/누락/이력 부족/최신 일봉 부재 제외는 기존 테스트와 함께 검증합니다.
- 수동 검색의 HTTP 통합 중에는 AI requests/rooms 테이블에 행이 생기지 않는 것을 확인했습니다. 별도 fixture AI 요청에서는 실제 SQLite 검색 도구의 결과·조건 정의·근거가 SQL 대화에 저장되고 복원됨을 확인했습니다.

## 합성 성능

새 임시 SQLite: 2,715종목 × 750봉, 약 594MiB. RSI+BB+SMA+평균 거래량 복합 엔진, tool_seconds=12.

| 실행 | 시간 | 검사 완료 | 미검사 | 캐시 |
|---|---:|---:|---:|---|
| cold | 11.0386초 | 2,176 | 539 | false |
| resume | 2.7133초 | 2,715 | 0 | false |
| cache | 약 0.05초 | 2,715 | 0 | true |

최종 유효 2,665 / 격리 45 / 워밍업 부족 5. 합성 DB의 검사 범위이며 운영 시간·건수를 보장하지 않습니다. 모든 snapshot 해제를 확인했고, 운영 DB는 벤치마크에 사용하지 않았습니다.

## 별도 확인이 필요한 범위

- 실제 VPS 운영 SQLite 3.37.2에서 새 커밋의 gate 통과 및 두 서비스 배포.
- Vercel에서 새 프론트/프록시와 VPS의 연결.
- 실제 OpenAI 모델의 자연어 조건 해석/도구 선택 품질. API 키 설정 및 유료 호출은 수행하지 않았습니다.

배포 절차와 중단·복구 기준은 `deploy/SCREENER_VPS_HERMES.md`를 따릅니다. Supabase SQL 변경/재실행은 없습니다.
