# ATLAS Lab OHLC 품질 처리 배포 (0620)

## 정책과 변경 범위

- 출처는 `FDR:NAVER` 그대로 유지한다. 원인이 반올림이라고 단정하지 않는다.
- 양수 OHLC 범위 안에 시가가 있고 **종가만 정확히 1원** 이탈한 경우 고가/저가 범위를 종가까지 넓힌다. 시가·종가·거래량은 바꾸지 않는다.
- 1원 초과, 시가 이탈, 뒤집힌 범위 등은 격리한다. 종목의 나머지 정상 봉은 저장한다. 날짜를 삭제하여 앞뒤를 이어 붙이거나 보간하지 않는다.
- `raw_candles`: FDR에서 읽은 날짜·OHLCV, 출처, SHA-256, 최초/최근 수신 시각. 동일 원본 재수집은 중복 삽입하지 않는다. 제공처 응답이 달라지면 이전 버전을 보존한다. HTTP 응답 전문을 저장하는 것은 아니다.
- `candle_quality_versions`: 원본 버전별 정책·처리·이유·이탈액·가공 고가/저가·시각. `candle_quality`와 `current_candle_quality`는 현재 적용 상태.
- `legacy_candle_snapshots`: 기존 데이터가 처음 갱신될 때 변경 전 값을 보존한다. 이를 새로 수신한 원본이라고 표기하지 않는다. 스키마 추가만으로 기존 일봉을 가공하지 않는다.
- 차트/API의 격리 일봉은 날짜와 `quality=quarantined`, null 가격으로 전달한다. 이전에 정상 저장값이 있더라도 현재 오류 상태에서는 사용하지 않는다.
- 선택 기간 또는 필요한 지표 준비 구간에 격리가 있으면 백테스트 실행을 차단한다. SMA/볼린저/거래량 평균은 필요한 준비 구간, EMA/RSI/MACD는 저장된 이전 이력 전체를 확인한다. 차트의 지표는 오류 이후 새 구간에서 재계산한다.
- 결과 JSON v2에 정책, 오류 일봉 원본/가공 내역, 사용 데이터와 보정 봉 사용 수를 포함한다.
- Supabase 전략 저장·증권사 API·실제 주문·기존 타이머 정의는 변경하지 않는다.

## 1. 실행 중 수집 확인 및 백업

경로 `/opt/atlas`, 실행 사용자 `atlas`, DB `/var/lib/atlas/lab.sqlite`, 가상환경 `/opt/atlas/.venv-lab` 기준. 아래 명령은 VPS의 Bash에서 실행한다. 비밀키나 환경파일 전체 내용을 출력하지 않는다.

1. `systemctl show atlas-lab-collect.service -p ActiveState -p SubState -p MainPID`와 수집 프로세스를 확인한다. 현재 수집 중이면 **강제 중지하거나 실행 중 소스를 교체하지 말고 종료까지 기다린다.** 수동 수집 프로세스도 확인한다.
2. `atlas-lab-collect.timer`의 기존 enabled/active 상태와 다음 실행을 기록한다. 서비스가 멈춘 상태에서 배포·복구 작업 동안 **타이머만 일시 정지**한다. 서비스/타이머 유닛 내용은 바꾸지 않는다.
3. 로컬 수정이 있으면 덮어쓰지 말고 보고한다. 작업 트리 clean 확인 후 현재 커밋·서비스 상태·설정과 DB를 백업한다. 원본/이력 저장으로 DB가 증가하므로 디스크 여유도 확인한다.

```bash
cd /opt/atlas
sudo -u atlas git status --short
sudo -u atlas git rev-parse HEAD
systemctl is-enabled atlas-lab-collect.timer
systemctl is-active atlas-lab-collect.timer
systemctl list-timers atlas-lab-collect.timer --all --no-pager
sudo systemctl stop atlas-lab-collect.timer
systemctl show atlas-lab-collect.service -p ActiveState -p SubState -p MainPID
df -h /var/lib/atlas /var/backups
```

정지와 재확인 사이에 수집이 시작됐으면 종료를 기다린다. 수집기가 없음을 확인한 뒤:

```bash
backup_dir="/var/backups/atlas/quality-$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -m 0700 "$backup_dir"
sudo cp -a /etc/atlas/atlas.env "$backup_dir/atlas.env"
sudo cp -a /etc/systemd/system/atlas-api.service "$backup_dir/atlas-api.service"
sudo cp -a /etc/systemd/system/atlas-lab-collect.service "$backup_dir/atlas-lab-collect.service"
sudo cp -a /etc/systemd/system/atlas-lab-collect.timer "$backup_dir/atlas-lab-collect.timer"
sudo sqlite3 /var/lib/atlas/lab.sqlite ".backup '$backup_dir/lab.sqlite'"
sudo sqlite3 -readonly "$backup_dir/lab.sqlite" 'PRAGMA integrity_check;'
sudo -u atlas git rev-parse HEAD | sudo tee "$backup_dir/git-head.txt"
```

SQLite WAL 파일 누락을 피하려고 파일 복사 대신 SQLite backup API를 쓴다. 별도 수집 프로세스가 있거나 DB 무결성 검사가 실패하면 진행하지 않는다.

## 2. 코드·스키마·API 반영

```bash
cd /opt/atlas
sudo -u atlas git pull --ff-only origin main
sudo -u atlas git log -1 --oneline
sudo -u atlas npm run test:server
sudo -u atlas /opt/atlas/.venv-lab/bin/python -m unittest discover -s lab -p 'test_*.py' -v
sudo -u atlas /opt/atlas/.venv-lab/bin/python lab/collect.py \
  --db /var/lib/atlas/lab.sqlite --migrate-only
sudo sqlite3 -readonly /var/lib/atlas/lab.sqlite 'PRAGMA integrity_check;'
sudo systemctl restart atlas-api.service
curl --fail http://127.0.0.1:3000/api/health
curl --fail http://127.0.0.1:3000/api/public/lab/symbols
```

`0620` 커밋(또는 이를 포함한 후속 main)인지 확인한다. 의존성 추가가 없어 pip/npm 패키지 재설치는 필요 없다. 기존 환경변수·키·포트도 그대로다. 테스트 실패 시 배포를 중단하고 원인을 보고한다. 스키마 추가는 파일 잠금을 사용하고 여러 번 실행해도 동일하다. API는 이전 DB도 읽을 수 있지만 새 품질 처리는 스키마 추가와 재수집 후 적용된다.

## 3. 실패 종목만 5년 재수집

대상 수를 먼저 확인한다. 최초 복구 전 보고 기준은 285개다. 이미 수집 상태가 바뀌었으면 실제 대상을 기록한다.

```sql
SELECT count(*) FROM symbols WHERE active=1 AND
 (error='Invalid OHLC range' OR code IN
  (SELECT code FROM current_candle_quality WHERE status='quarantined'));
```

기존 진단과 같은 기간 `2021-09-28`~`2026-09-28`로 한 번 복구한다. 원본을 새로 조회하므로 결과가 진단 CSV와 달라질 수 있다. 다음 명령은 비동기 systemd 임시 서비스로 SSH 종료 후에도 계속 실행된다. 기존에 같은 임시 서비스가 실행 중이면 추가 실행하지 않는다.

```bash
sudo systemd-run --unit=atlas-lab-quality-repair --uid=atlas --gid=atlas \
  --working-directory=/opt/atlas --property=Type=oneshot \
  --property=TimeoutStartSec=270min \
  /opt/atlas/.venv-lab/bin/python /opt/atlas/lab/collect.py \
  --db /var/lib/atlas/lab.sqlite --source NAVER \
  --retry-invalid-ohlc --full --end 2026-09-28 --delay 0.75 --max-minutes 260
systemctl status atlas-lab-quality-repair --no-pager
journalctl -u atlas-lab-quality-repair -n 30 --no-pager
```

OS 파일 잠금도 중복 수집을 막는다. 복구 중 타이머는 일시 정지 상태로 둔다. `activating (start)`는 oneshot 수집 진행 상태일 수 있다. **종료 후에만 다음 단계로 진행**한다. 자동 수집의 날짜 제한을 과거로 바꾸거나 기존 유닛에 `--end`를 넣지 않는다.

## 4. 결과 검증과 타이머 복원

```sql
SELECT * FROM runs ORDER BY id DESC LIMIT 3;
SELECT status,count(*) AS days,count(DISTINCT code) AS symbols
 FROM current_candle_quality GROUP BY status;
SELECT q.code,s.name,count(*) AS days,max(q.delta) AS max_delta
 FROM current_candle_quality q JOIN symbols s USING(code)
 WHERE q.status='quarantined' GROUP BY q.code ORDER BY q.code;
SELECT count(DISTINCT code) AS stored_symbols,count(*) AS candles FROM candles;
```

- 제공처 원본이 진단 CSV와 같다면 오류 1,597일 중 **보정 1,477일 / 격리 120일**, 격리 종목 **49개**, 복구 대상 285개 중 전체 유효 236개가 예상된다. 이는 기대치이며 실제 DB 수치를 보고한다.
- 49개 종목도 정상 날짜는 저장된다. 따라서 `failed`는 일봉이 전혀 없다는 의미와 다르다. 현재 구현은 격리가 하나라도 남으면 해당 종목을 failed로 세고 프로세스 exit 1을 유지한다. 전체 수집 중단과 구별해 `runs.message`, 로그, 품질 집계를 함께 확인한다.
- 백업 DB와 비교하여 **복구 대상 밖 기존 정상 종목의 OHLCV가 바뀌지 않았는지** 확인한다. 보정의 시가·종가·거래량은 원본과 같고, 고가·저가만 범위를 넓혔는지 확인한다. raw/quality 이력이 재실행으로 중복 증가하지 않는지 확인한다.
- API에서 보정 종목의 `quality.issues`, 격리 날짜의 null 가격, 정상 날짜의 가격을 확인한다. 캐시는 최대 60초다. 날짜별 원본과 처리 내역은 웹에서 펼쳐 볼 수 있다. 격리가 선택/준비 구간에 있는 백테스트는 차단되어야 한다.
- `PRAGMA integrity_check`가 ok이고 API가 정상인지 확인한다. 완료/실패 여부와 무관하게 운영 상태를 보고하고, 현재 프로세스 종료를 확인한 뒤 기존 타이머 상태를 복원한다. 이 VPS는 기존 enabled/active였으므로 아래처럼 시작한다. 유닛 내용은 변경하지 않는다.

```bash
sudo systemctl start atlas-lab-collect.timer
systemctl is-enabled atlas-lab-collect.timer
systemctl is-active atlas-lab-collect.timer
systemctl list-timers atlas-lab-collect.timer --all --no-pager
```

한국시간 21:00/03:00 유지 여부와 다음 실행을 보고한다. 복구 완료가 예정 시각을 넘겼다면 누락된 정기 실행을 보고하고, 필요하면 타이머가 쓰는 기존 `atlas-lab-collect.service`를 한 번 수동 시작해 최신 완료 거래일까지 갱신한다. 진행 중인 수집과 겹치지 않게 한다.

원본/처리 이력은 5년 가공 데이터 보존 기간과 별개로 삭제하지 않으므로 디스크 사용량과 백업을 관리한다. 중대 실패 시 타이머를 무조건 재개하거나 구버전으로 단순 git 되돌리기 하지 말고 보고한다. 구버전은 격리 메타데이터를 해석하지 못하므로 롤백에는 **일치하는 코드와 배포 전 DB 백업**이 필요하다. 현재 DB/이력은 먼저 별도로 보존한다.

Vercel은 GitHub main 푸시로 자동 배포된다. 웹 자동 배포와 VPS DB 처리 완료는 별개이며, 완료 보고에 각각 확인 범위를 명시한다.
