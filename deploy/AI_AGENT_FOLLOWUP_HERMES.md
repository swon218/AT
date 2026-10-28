# 2026-10-28 후속 수정 전달문

ATLAS `main`에서 사용자가 전달한 최종 커밋 해시를 확인한 뒤 다음 범위만 반영해 주세요. 키 없이 실행하며 유료 모델 호출은 0건을 유지합니다. 이 문서는 최초 설치 절차를 다시 실행하라는 뜻이 아닙니다.

## SQLite 3.37.2 롤백 이후 재배포 게이트

이전 `8da3780`과 `bb2a1e4`는 운영 SQLite의 읽기 연결·snapshot 수명에 따른 data_version 변화 때문에 운영 gate를 통과하지 못했습니다. 이번 수정은 **PRAGMA data_version을 캐시/변경 감지에 사용하지 않습니다.** `sqlite-physical-commit-v1` fingerprint로 실제 DB 헤더와 WAL 커밋 끝점(검증된 WAL-index, salt, 프레임 checksum·페이지)을 확인합니다. SHM의 read mark/iChange는 fingerprint에 포함하지 않습니다. 파일 크기/mtime만으로 판단하지 않습니다.

raw DB 파일 열기/닫기가 SQLite 프로세스의 POSIX 잠금을 해제하지 않도록, 파일 검증은 SQLite를 import하지 않는 별도 stdlib 전용 보조 프로세스에서 읽기만 합니다. 이 프로세스에는 AI/브로커/Supabase 비밀 환경변수를 전달하지 않습니다. DB/WAL/SHM에 쓰거나 checkpoint·권한 변경을 하지 않습니다. 부모가 snapshot을 고정하기 전·직후·해제 후 fingerprint가 같은 경우에만 같은 캐시/진행 상태를 사용합니다. 실제 변경은 ScanChanged로 폐기하고, 파일 형식·권한·진행 중 쓰기 등으로 검증하지 못하면 FingerprintUnavailable/`screen_snapshot_unverified`로 거부합니다. 커스텀 VFS나 읽을 수 없는 active WAL-index를 추측해 통과시키지 않습니다.

1. 현재 롤백 상태와 기존 비공개 백업을 보존하세요. 원격 main에 있는 **사용자가 전달한 새 수정 해시**를 격리 worktree에서 먼저 검증하세요. 운영 SQLite/서비스를 새 worktree로 옮기거나 DB를 복사·초기화하지 마세요. 별도 worktree의 코드와 기존 Python 환경을 사용하되 현재 디렉터리/모듈 경로가 새 코드인지 확인하세요.
2. Python 전체 테스트 38개, 기존 통합 테스트, 아래 읽기 전용 운영 성능 명령을 **운영 checkout을 갱신하기 전에** 실행하세요. 수집이 실행 중이면 기록하고 유휴 시간에 다시 gate를 확인하세요. 실제 commit 때문에 생긴 ScanChanged를 우회하거나 무조건 성공 처리하지 마세요. 먼저 `python -I -S ai_agent/snapshot_fingerprint.py /var/lib/atlas/lab.sqlite`를 실제 AI 서비스 사용자로 실행해 `format=sqlite-physical-commit-v1`과 token을 확인하세요. 오류라면 error 코드와 DB/WAL/SHM의 존재·크기·읽기 권한만 보고하고 권한을 임의 변경하지 마세요. raw header나 데이터 행을 전송할 필요는 없습니다.
3. 아래 진단에서 data_version 값이 2→4→5처럼 달라도 **읽기 전용 수명 전후 fingerprint가 같은지** 확인하세요. 첫 cold 검색부터 예외 없이 실제 scanned/not_scanned를 출력하고, 동일 fingerprint의 다음 검색에서 이어받기와 전체 cache hit가 정상인지 확인하세요. 매 실행 후 `reader.in_transaction=false`여야 합니다. 데이터가 갱신되면 캐시 무효화/새 검색으로 동작해야 합니다. WAL writer 검증은 운영 DB에 UPDATE하지 않고 회귀 테스트용 DB에서만 수행하세요.
4. gate를 통과한 뒤에만 운영 checkout을 해당 새 해시로 fast-forward하고 `atlas-ai.service`만 재시작하세요. 적용 후 같은 gate와 health를 다시 확인하세요. 실패하면 기존 롤백 정책을 유지하고 재현 값·runtime·수집 실행 여부를 보고하세요. Node/Vercel 경로는 이미 실제 CRUD 검증을 통과했으므로 이번 배포를 위해 Node 설정이나 서비스를 바꾸지 마세요.
5. 운영 SQLite 라이브러리 업그레이드, Supabase SQL 재실행, 시간 한도/품질 정책 변경, OpenAI 키 설정·유료 호출은 하지 마세요. 로컬 격리 DLL은 운영에 복사하지 않습니다.

## 반영 범위

1. Vercel: `vercel.json`에서 `/api/agent/:atlas_route*`를 정적 함수 `api/agent-proxy.js`로 rewrite합니다. 허용된 방/메시지/요청 경로만 전달하며 내부 routing parameter는 제거합니다. 본문 없는 DELETE에는 JSON Content-Type을 보내지 않습니다. 기존 `ATLAS_API_ORIGIN=https://srv1826612.tail6bd3f3.ts.net`을 유지합니다.
2. Python: `ai_agent/krx_closures.py`의 2026-06-03 지방선거일과 2026-07-17 제헌절을 XKRX 중앙 달력에 반영합니다. 거래일 이동과 RSI 누락 검사가 같은 달력을 사용합니다. 가짜 봉 추가나 DB 수정은 하지 않습니다. [공식 KRX KIND 원문(코넥스)](https://kind.krx.co.kr/external/2026/05/20/000110/20260520000197/32154.htm)과 [KRX 전체 시장 발표 보도](https://www.yna.co.kr/view/AKR20260520064251008)를 확인했습니다.
3. RSI: 64종목 단위의 인덱스 범위 조회, 현재 품질 맵과 정확한 version/raw identity의 배치 연결, 실제 DB/WAL 커밋 fingerprint를 사용하는 공개 지표 캐시(60초)입니다. 품질 기록/원자료 누락, 격리, 실제 거래일 누락, OHLC 유효성, 준비 봉 검사는 유지합니다. 최대 2,000봉 및 12초 도구 한도/약 11초 검색 예산도 유지합니다. 끝내지 못한 검색은 `not_scanned`와 `cache_hit=false`로 공개하고 같은 fingerprint의 다음 검색에서만 진행 상태를 이어받습니다. `resumed`는 이어받은 검사 종목 수이며 첫 조회 TTL은 연장하지 않습니다. 전체를 확인한 캐시만 hit로 표시합니다. 첫 검색 한 번에 전체 종목 완료를 보장하지 않습니다.

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
from ai_agent.snapshot_fingerprint import fingerprint, FORMAT
from pathlib import Path
s = Settings(lab_path='/var/lib/atlas/lab.sqlite', tool_seconds=12, screen_symbols=3000)
ctx = market_context(datetime.now(KST), s.calendar_through)
print(json.dumps({'calendar_source': ctx['calendar_source'], 'cutoff': ctx['latest_completed'],
                  'june3_session': calendar().is_session('2026-06-03'),
                  'july17_session': calendar().is_session('2026-07-17')}))
scanner = RsiScreener()
try:
    path = Path(s.lab_path).resolve()
    reader = scanner._connect(path)
    try:
        first = fingerprint(path)
        before = reader.execute('PRAGMA data_version').fetchone()[0]
        reader.execute('BEGIN')
        reader.execute('SELECT rootpage FROM sqlite_master LIMIT 1').fetchone()
        inside = reader.execute('PRAGMA data_version').fetchone()[0]
        middle = fingerprint(path)
        reader.rollback()
        after = reader.execute('PRAGMA data_version').fetchone()[0]
        last = fingerprint(path)
        print(json.dumps({'format': FORMAT, 'diagnostic_data_version': [before, inside, after],
                          'readonly_fingerprint_stable': first == middle == last,
                          'db_latest': reader.execute('SELECT max(date) FROM candles').fetchone()[0]}))
        assert first == middle == last, 'DB/WAL changed or fingerprint unstable; inspect before deploying'
    finally:
        reader.rollback(); reader.close()
    for run in ('cold', 'resume_or_cache', 'cache_check'):
        begin = time.monotonic()
        result = scanner.scan(s, 'ALL', ctx['latest_completed'])
        print(json.dumps({'run': run, 'seconds': round(time.monotonic()-begin, 4),
                          'snapshot_released': not next(iter(scanner.entries.values()))['reader'].in_transaction,
                          **{k:v for k,v in result.items() if k != 'items'}}))
finally:
    scanner.close()
PY
```

보고 항목은 `universe/scanned/valid/excluded/not_scanned(=universe-scanned)/cache_hit/resumed/elapsed`, 실행 시각, SQLite/OS/Python 버전입니다. 첫 cold 검색, 진행 재개, 전체 결과 캐시 hit를 구분하세요.

장 마감 후 21시 수집 이전 등에는 calendar cutoff보다 DB 최신 일봉이 하루 오래될 수 있습니다. 이 경우 stale_data 제외는 정상적인 데이터 시점 제한이며 ScanChanged와 구분하세요. gate 통과를 위해 cutoff를 몰래 이전 날짜로 바꾸거나 가짜 봉을 만들지 마세요. 필요하면 이전 확정일을 명시한 별도 과거 데이터 진단으로 보고하세요.

2026-10-27 확정 데이터에 대한 이전 읽기 전용 시뮬레이션은 2,715종목 중 valid=2,665, quarantine=45, warmup=5, missing_sessions=0이었습니다. 이는 이전 보고 시점의 참고값이며 현재 값의 보장이 아닙니다. 새 코드로 실측하고 미검색이 남으면 건수를 보고하되 시간 제한은 임의 연장하지 마세요. 로컬 합성 데이터 벤치마크와 VPS 운영 측정을 구분하세요.

## 이번 범위 밖

45종목 quarantine의 운영 DB 재수집·보정·삭제, nonzero exit 정책 변경, 검증 범위 연장, OpenAI 키 설정·유료 호출은 수행하지 마세요. 복제 SQLite에서의 재수집 진단은 별도 작업입니다. 이번 수정으로 `atlas-lab-collect.service`의 정책적 exit 1이 자동으로 없어졌다고 보고하지 마세요.

대규모 로컬 합성 성능 재현은 `python -m ai_agent.tests.benchmark_rsi --symbols 2715 --bars 1250 --profile-queries`입니다. 실제 lab 스키마를 쓰는 새 임시 DB만 생성·정리합니다. cold와 재개 두 번의 제한된 검색까지 합쳐도 끝내지 못하면 종료 코드가 1이며 측정 결과를 출력합니다. 실제 운영 DB 경로를 인자로 받지 않습니다.

2GiB 이상 파일 크기 조건을 포함한 합성 검증은 `--raw-padding 400 --max-scans 3`을 추가합니다. raw JSON에 합성 padding을 넣은 유효한 임시 SQLite이며, 운영 데이터의 복제본은 아닙니다. `reader_probe`는 이 임시 DB에서 이전 두 연결 방식의 native data_version 변화를 출력합니다. 환경에 따라 false가 나올 수 있으며, 이를 운영 gate 통과 증거로 대신하지 않습니다. 각 검색은 여전히 기본 12초 한도 내에서 수행합니다.
