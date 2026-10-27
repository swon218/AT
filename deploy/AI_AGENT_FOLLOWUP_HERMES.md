# 2026-10-28 후속 수정 전달문

ATLAS `main`에서 사용자가 전달한 최종 커밋 해시를 확인한 뒤 다음 범위만 반영해 주세요. 키 없이 실행하며 유료 모델 호출은 0건을 유지합니다. 이 문서는 최초 설치 절차를 다시 실행하라는 뜻이 아닙니다.

## 반영 범위

1. Vercel: `vercel.json`에서 `/api/agent/:atlas_route*`를 정적 함수 `api/agent-proxy.js`로 rewrite합니다. 허용된 방/메시지/요청 경로만 전달하며 내부 routing parameter는 제거합니다. 본문 없는 DELETE에는 JSON Content-Type을 보내지 않습니다. 기존 `ATLAS_API_ORIGIN=https://srv1826612.tail6bd3f3.ts.net`을 유지합니다.
2. Python: `ai_agent/krx_closures.py`의 2026-06-03 지방선거일과 2026-07-17 제헌절을 XKRX 중앙 달력에 반영합니다. 거래일 이동과 RSI 누락 검사가 같은 달력을 사용합니다. 가짜 봉 추가나 DB 수정은 하지 않습니다. [공식 KRX KIND 원문(코넥스)](https://kind.krx.co.kr/external/2026/05/20/000110/20260520000197/32154.htm)과 [KRX 전체 시장 발표 보도](https://www.yna.co.kr/view/AKR20260520064251008)를 확인했습니다.
3. RSI: 64종목 단위의 인덱스 범위 조회, 현재 품질 맵과 정확한 version/raw identity의 배치 연결, 같은 DB connection의 `PRAGMA data_version`을 사용하는 공개 지표 캐시(60초)입니다. 품질 기록/원자료 누락, 격리, 실제 거래일 누락, OHLC 유효성, 준비 봉 검사는 유지합니다. 최대 2,000봉 및 12초 도구 한도/약 11초 검색 예산도 유지합니다. 끝내지 못한 검색은 `not_scanned`와 `cache_hit=false`로 공개하고 같은 DB 버전의 다음 검색에서만 진행 상태를 이어받습니다. `resumed`는 이어받은 검사 종목 수이며 첫 조회 TTL은 연장하지 않습니다. 전체를 확인한 캐시만 hit로 표시합니다. 첫 검색 한 번에 전체 종목 완료를 보장하지 않습니다.

## 배포

- 기존 백업/사용자 변경을 보존하고 `git fetch origin main`, `git pull --ff-only origin main` 후 전달받은 해시를 대조하세요. 예상과 다르면 강제 덮어쓰기 없이 차이를 보고하세요.
- 의존성 lock과 Supabase SQL 변경은 없습니다. 운영 SQL을 다시 실행하거나 테이블을 초기화하지 마세요.
- `AI_PUBLIC_ORIGIN=https://at-chi-six.vercel.app` 수정 결과를 보존하세요. Node 환경/서비스는 이번 Python 반영을 위해 변경할 필요가 없습니다.
- Python 테스트를 먼저 통과시킨 뒤 `atlas-ai.service`만 재시작하고 상태·loopback 리스닝·기존 health check를 확인하세요. 환경파일이나 키 값은 출력하지 마세요.
- Vercel의 새 배포가 해당 커밋으로 Production/Ready인지 확인하세요. 이전 배포가 Current이면 새 배포 완료 후 다시 검사하세요.
- 기존 수집/cleanup timer, paper-api/futures-lab, 주문·계좌·자산 서비스는 보존하세요.

## 키 없는 운영 검증

실제 웹에서 게스트 쿠키를 발급받아 테스트용 빈 방 하나로 생성→목록 복원→제목 변경→메시지 목록 복원→삭제를 확인하세요. 테스트 과정에서 만든 방만 정리하고 기존 대화는 건드리지 마세요. 중첩 GET/PUT/DELETE가 Vercel 플랫폼 `NOT_FOUND`가 아닌 Node 응답인지 구분하세요. 키 미설정 질문은 503 `api_key_missing`, 과금/쿼터 차감/질문 저장 없음이 유지되어야 합니다. 인증 없는 임의 UUID 조회만 성공한 것은 실제 CRUD 검증으로 보고하지 마세요.

다음은 운영 SQLite를 읽기만 하는 별도 성능 확인입니다. 실제 경로와 AI 서비스 사용자를 확인한 뒤 실행하세요. 환경파일을 source하지 않으며 Provider를 만들지 않으므로 OpenAI/Naver 요청은 발생하지 않습니다. 운영 수집이 동시에 실행 중이면 그 사실도 기록하세요.

```sh
cd /opt/atlas
sudo -u atlas-ai /opt/atlas/.venv-ai/bin/python - <<'PY'
from datetime import datetime
import json, time
from ai_agent.config import Settings
from ai_agent.market import KST, calendar, market_context
from ai_agent.screener import RsiScreener
s = Settings(lab_path='/var/lib/atlas/lab.sqlite', tool_seconds=12, screen_symbols=3000)
ctx = market_context(datetime.now(KST), s.calendar_through)
print(json.dumps({'calendar_source': ctx['calendar_source'], 'cutoff': ctx['latest_completed'],
                  'june3_session': calendar().is_session('2026-06-03'),
                  'july17_session': calendar().is_session('2026-07-17')}))
scanner = RsiScreener()
try:
    for run in ('cold', 'resume_or_cache', 'cache_check'):
        begin = time.monotonic()
        result = scanner.scan(s, 'ALL', ctx['latest_completed'])
        print(json.dumps({'run': run, 'seconds': round(time.monotonic()-begin, 4),
                          **{k:v for k,v in result.items() if k != 'items'}}))
finally:
    scanner.close()
PY
```

보고 항목은 `universe/scanned/valid/excluded/not_scanned(=universe-scanned)/cache_hit/resumed/elapsed`, 실행 시각, SQLite/OS/Python 버전입니다. 첫 cold 검색, 진행 재개, 전체 결과 캐시 hit를 구분하세요.

2026-10-27 확정 데이터에 대한 이전 읽기 전용 시뮬레이션은 2,715종목 중 valid=2,665, quarantine=45, warmup=5, missing_sessions=0이었습니다. 이는 이전 보고 시점의 참고값이며 현재 값의 보장이 아닙니다. 새 코드로 실측하고 미검색이 남으면 건수를 보고하되 시간 제한은 임의 연장하지 마세요. 로컬 합성 데이터 벤치마크와 VPS 운영 측정을 구분하세요.

## 이번 범위 밖

45종목 quarantine의 운영 DB 재수집·보정·삭제, nonzero exit 정책 변경, 검증 범위 연장, OpenAI 키 설정·유료 호출은 수행하지 마세요. 복제 SQLite에서의 재수집 진단은 별도 작업입니다. 이번 수정으로 `atlas-lab-collect.service`의 정책적 exit 1이 자동으로 없어졌다고 보고하지 마세요.

대규모 로컬 합성 성능 재현은 `python -m ai_agent.tests.benchmark_rsi --symbols 2715 --bars 1250 --profile-queries`입니다. 실제 lab 스키마를 쓰는 새 임시 DB만 생성·정리합니다. cold와 재개 두 번의 제한된 검색까지 합쳐도 끝내지 못하면 종료 코드가 1이며 측정 결과를 출력합니다. 실제 운영 DB 경로를 인자로 받지 않습니다.
