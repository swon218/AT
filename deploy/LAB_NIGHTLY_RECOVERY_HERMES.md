# 헤르메스 전달문 · 실험실 일봉 복구 및 수집 개선

배포 대상은 GitHub의 `실험실 일봉 복구 및 수집 개선` 커밋이다. 아래에서 전달받은 SHA를 사용하고, 운영 DB에서 후보가 실제 승인·게시됐는지는 결과로 별도 보고한다. 작업 위치는 `/opt/atlas`, 운영 DB는 `/var/lib/atlas/lab.sqlite` 기준이다.

## 데이터와 게시 규칙

- 21시 `primary`는 완료 KRX 거래일 D의 실제 목록을 고정하고 원본·판정·종목별 결과를 적재한다. 웹 가격은 이전 공개 버전을 읽는다.
- 03시 `confirm`은 전날 21시의 거래일 D를 달력으로 계산하고 저장된 대상 목록을 재사용한다. 미처리·실패를 먼저 조회하고, 21시 통과 결과는 저장 예정 데이터와 전체 기간을 확인한다. 필요하면 `--check-short`를 주어 최근 7일도 조회할 수 있다. 최근 겹치는 원본 값이 변하면 해당 종목은 전체 보존 기간을 다시 요청한다.
- 03시 작업이 끝나면 SQLite 트랜잭션 하나로 통과 종목의 공개 데이터를 갱신한다. 잔여 실패 종목은 마지막 사용 가능한 봉과 목표 날짜·실패 상태를 표시한다. 양쪽 모두 실패한 날은 이전 공개 데이터 기준일을 유지한다. 03시는 시작 시각이며 게시 시각은 API의 `published_at`이다.
- 보존 시작일은 `max(D의 5년 전, 확인된 상장일)`이다. 휴장일에는 직전 완료 거래일을 사용한다. 동일 거래일의 게시를 이미 마쳤으면 21시 작업은 생략되며, 03시 재실행은 남은 대상만 처리한다.
- 거래량 0, 종목 목록의 가격 열, 공급자의 날짜 생략만으로 거래정지를 추정하지 않는다. 출처에 맞는 무거래 근거 또는 별도 상장일 근거가 필요하면 아래 명령으로 등록한다.
- 운영 모드에서는 기존 1원 보정 이력을 감사용으로 보존하고 사용 가능한 봉에서는 격리한다. 새 값에 1원 보정이나 보간을 적용하지 않는다. 전환 전 복제본에서 격리 증가량을 반드시 보고한다.
- 종료 코드는 `0` 전부 완료 또는 확인된 비거래, `2` 일부 실패·미처리, `1` 성공 대상 없음 또는 실행 장애다. systemd는 `2`를 허용하되 로그와 DB에는 실제 분류가 남는다.
- `exchange-calendars==4.13.2`와 저장소 KRX 검토 휴장일을 사용한다. 기본 검토 범위는 2026-12-31까지다. 다음 연도 달력·임시 휴장을 검토해 `LAB_CALENDAR_THROUGH`를 갱신한다. 범위를 넘기면 수집이 중단된다.

## 1. SHA 확인 및 SQLite 백업

```bash
cd /opt/atlas
SHA='<전달받은 전체 커밋 SHA>'
git fetch origin main
git show --no-patch --oneline "$SHA"
git status --short
# 운영 작업트리가 깨끗하고 승인된 SHA인지 확인한 뒤 배포 절차에 따라 반영한다.
git merge --ff-only "$SHA"
test "$(git rev-parse HEAD)" = "$SHA"
PY=/opt/atlas/.venv-lab/bin/python
DB=/var/lib/atlas/lab.sqlite
DIAG='<VPS 진단 CSV와 보고서가 있는 디렉터리>'
sudo systemctl stop atlas-lab-collect.timer atlas-lab-collect.service
# 재배포라면 이미 설치된 atlas-lab-confirm.timer와 .service도 중지한다.
sudo install -d -o atlas -g atlas -m 0750 /var/lib/atlas/backups
BACKUP="/var/lib/atlas/backups/lab-pre-nightly-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
REHEARSAL="${BACKUP%.sqlite}-rehearsal.sqlite"
sudo -u atlas "$PY" - "$DB" "$BACKUP" "$REHEARSAL" <<'PY'
import sqlite3, sys
from contextlib import closing
from pathlib import Path
src, *outputs = map(Path, sys.argv[1:])
assert src.is_file() and all(not p.exists() for p in outputs)
with closing(sqlite3.connect(src.resolve().as_uri() + '?mode=ro', uri=True)) as original:
    for p in outputs:
        with closing(sqlite3.connect(p)) as copy:
            original.backup(copy)
            assert copy.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
PY
# 가상환경 소유 계정으로 의존성을 설치한다.
"$PY" -m pip install -r lab/requirements.txt
sudo -u atlas "$PY" lab/collect.py --db "$REHEARSAL" --migrate-only
```

백업은 SQLite backup API로 만든다. WAL 모드 운영 중인 DB 파일 하나만 복사하면 커밋된 최신 데이터가 빠질 수 있다. 기존 WAL 가드 및 읽기 전용 ACL도 유지한다.

## 2. 복제본에서 후보 검증·승인

진단 디렉터리에는 `problem_candles.csv`, `source_comparison_recovery.csv`, `recovery_candidates.csv`, `trial_candidate_validation.csv`, `source_basis_and_limits.csv`, `diagnostic_report.md`가 필요하다. 세부 값과 현재 원본 source/hash/policy가 맞고 보존 기간 안에 있는 C 후보만 등록한다. 출력의 `reconstruction_review`는 기간 재구성 검토 목록이다.

```bash
sudo -u atlas "$PY" lab/recovery.py --db "$REHEARSAL" import-candidates "$DIAG"
sudo -u atlas "$PY" lab/recovery.py --db "$REHEARSAL" import-candidates "$DIAG" --register
```

관리자 키움 읽기 전용 조회에 사용하는 기존 자격 증명은 VPS 비밀 관리 절차로 `/etc/atlas/lab-kiwoom.env`에 연결한다. root가 읽는 별도 권한 제한 파일에 `KIWOOM_APP_KEY`, `KIWOOM_SECRET_KEY`와 필요한 경우 `KIWOOM_API_HOST`만 둔다. 앱 로그나 명령행에 값을 넣지 않는다. 조회 프로세스는 OAuth 발급과 `ka10081` 일봉만 사용한다.

```bash
broker_job() {
  sudo systemd-run --wait --pipe --collect -p User=atlas -p Group=atlas \
    -p WorkingDirectory=/opt/atlas -p EnvironmentFile=/etc/atlas/lab-kiwoom.env \
    -p 'Environment=DOTENV_CONFIG_PATH=/dev/null PYTHONDONTWRITEBYTECODE=1' -- "$@"
}
ID='<import-candidates 출력에서 검토한 candidate ID>'
broker_job "$PY" lab/recovery.py --db "$REHEARSAL" approve "$ID"
CODE='<검토한 종목코드>'
sudo -u atlas "$PY" lab/store.py --db "$REHEARSAL" --symbol "$CODE"
```

`accepted=true`를 확인한다. CLI는 현 DB의 양쪽 정상 5봉씩과 복구 후보 1봉을 지정된 키움 기준에서 재조회해 OHLCV를 비교한다. 승인·검증·원본 판정·실제 적용을 각각 이력으로 남긴다. 기준이 달라지거나 양쪽 5봉을 확보하지 못하면 적용되지 않는다. 같은 오류 원본과 주변 기준이 유지되면 다음 수집에서도 복구를 보존한다. 겹치는 과거 원본이 바뀌면 해당 종목을 전체 재검증하고, 영향이 확인된 복구는 보류한다. 늦게 소급된 정정이 최근 조회 구간 밖에만 있다면 별도 전체 재검증이 필요하다.

## 3. 종목별 기간 재구성

진단 D 분류를 일괄 승인하지 않는다. 종목마다 상장일, 조정과 거래량 기준, 시장 범위를 확정하고 `basis.json`에 검토자, 근거, 독립 참조 OHLCV를 기록한다. 적어도 2봉을 넣고 기업행위 전후 등 비교가 필요한 구간에서 선택한다. 아래 구조의 문자열과 값은 예시이므로 실제 근거로 바꾼다.

```json
{
  "source": "KIWOOM:KA10081:ADJUSTED:KRX",
  "listed": "2024-04-01",
  "reviewer": "검토자",
  "listing_reference": "거래소 상장 근거",
  "adjustment_reference": "수정주가 및 기업행위 검토 근거",
  "volume_reference": "거래량 조정 기준 확인 근거",
  "session_reference": "KRX 전용 또는 KRX+NXT 기준 근거",
  "reference_rows": [
    {"date": "2024-04-01", "open": 10000, "high": 11000, "low": 9000, "close": 10500, "volume": 12000},
    {"date": "2024-04-02", "open": 10500, "high": 11500, "low": 10000, "close": 11300, "volume": 15000}
  ]
}
```

```bash
SOURCE=KIWOOM:KA10081:ADJUSTED:KRX # 통합 검증 시 KIWOOM:KA10081:ADJUSTED:SOR
LISTED='<확인한 상장일 YYYY-MM-DD>'
basis_file='<검토된 basis.json 절대 경로>'
broker_job "$PY" lab/recovery.py --db "$REHEARSAL" rebase "$CODE" \
  --source "$SOURCE" --listed "$LISTED" --evidence "$basis_file"
sudo -u atlas "$PY" lab/recovery.py --db "$REHEARSAL" confirm-listing "$CODE" "$LISTED" \
  --evidence '<거래소 상장 근거>' # 재구성되지 않은 종목의 상장일 정보가 필요할 때만
sudo -u atlas "$PY" lab/recovery.py --db "$REHEARSAL" confirm-nontrade "$CODE" '<거래일>' \
  --source "$SOURCE" --evidence '<해당 시장 범위 전체의 확인 근거>'
```

재구성은 최근 5년 또는 상장일 이후 전체를 지정된 원천으로 가져온다. 참조 봉, 날짜 범위, 최신일, 누락 및 품질을 모두 검사해 한 종목씩 교체한다. 이후 정기 수집도 그 원천을 사용한다. 기존 진단 CSV는 개별 복구에 대한 증거이며, 전체 기간의 독립 검토 문서를 대신하지 않는다.

## 4. 게시 리허설 및 운영 반영

```bash
broker_job "$PY" lab/nightly.py primary --db "$REHEARSAL" --max-minutes 250
# 두 명령의 JSON target이 같은지 확인한다. 실제 시각은 아래 스케줄 기준이다.
broker_job "$PY" lab/nightly.py confirm --db "$REHEARSAL" --max-minutes 240
sudo -u atlas "$PY" lab/store.py --db "$REHEARSAL" |
  "$PY" -c 'import json,sys; print(json.dumps(json.load(sys.stdin).get("publication"), indent=2))'
```

수동 리허설에서 같은 D를 원하면 21시 전에 두 명령을 실행하거나, 21시 1차 실행 뒤 다음 날 03시 이후 확인한다. `--target YYYY-MM-DD`는 현재 공개 기준일보다 오래되지 않은 기존 완료 거래일 배치를 재개할 때 사용한다. 실제 수집량과 소요 시간, 21시 중 가격 미노출, 03시 부분 게시 및 미완료 표시, 승인 후보 반복 수집, 재구성 종목의 후속 키움 원천을 복제본에서 확인한다. 크게 줄어든 유효 종목 수를 성공으로 간주하지 않는다.

승인된 복제본 결과에 근거해 운영 DB에서 아래 순서로 실행한다.

1. `lab/collect.py --db "$DB" --migrate-only`로 스키마를 추가한다.
2. 운영 DB 기준으로 2절을 다시 실행해 원본 identity가 일치한 후보만 승인한다. 검토가 완료된 종목에 한해 3절의 재구성 명령을 실행한다.
3. 기존 읽기 전용 WAL 가드를 유지한 채 `atlas-api`, `atlas-ai`를 배포 커밋으로 갱신하고, 같은 커밋의 프런트엔드를 배포한다.
4. 타이머 두 개를 설치한다.

```bash
sudo install -m 0644 deploy/atlas-lab-{collect,confirm}.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/atlas-lab-{collect,confirm}.{service,timer}
sudo systemctl enable --now atlas-lab-collect.timer atlas-lab-confirm.timer
systemctl list-timers 'atlas-lab-*'
journalctl -u atlas-lab-collect.service -u atlas-lab-confirm.service --since today --no-pager
```

확인 기준은 두 배치의 동일 D, 공개 전후 버전 변화, 최신 반영·비거래·잔여 실패 합계와 목표 대상 수의 일치, 키움 승인·재구성 건수, 차트와 백테스트 JSON의 공개 버전 및 복구 근거, 조건검색 공개 버전이다. 조건검색은 `/opt/atlas/.venv-ai/bin/python -m deploy.screener_gate --db "$DB"`를 운영 읽기 권한으로 실행한다. VPS에서 직접 확인한 실제 숫자와 완료 시각을 보고한다.

## 5. 철회와 롤백

날짜별 승인 철회는 `lab/recovery.py --db "$DB" withdraw "$ID" --reason '<철회 근거>'`를 DB 소유 계정으로 실행한다. 원본과 승인·철회 이력은 남고 해당 봉의 유효 뷰는 즉시 갱신된다. 기존 데이터 기준으로 돌아갈 필요가 있으면 검증된 전체 재구성 또는 아래 백업 롤백을 사용한다.

전체 롤백은 두 수집 타이머·서비스와 모든 DB 연결을 쓰거나 읽는 서비스(API, AI, WAL 가드)를 정지한 유지보수 창에서 진행한다. 현재 DB와 사이드카를 별도 보관한 후 백업을 복원하고, 직전 코드·systemd 단위·프런트엔드 배포로 되돌린다.

```bash
sudo systemctl stop atlas-lab-{collect,confirm}.{timer,service} atlas-api atlas-ai atlas-lab-wal
HOLD="/var/lib/atlas/backups/lab-rollback-hold-$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -o atlas -g atlas -m 0750 "$HOLD"
for file in "$DB" "$DB-wal" "$DB-shm"; do
  if sudo test -e "$file"; then sudo mv -- "$file" "$HOLD/"; fi
done
sudo install -o atlas -g atlas -m 0640 "$BACKUP" "$DB"
sudo -u atlas "$PY" -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); assert c.execute("PRAGMA integrity_check").fetchall()==[("ok",)]' "$DB"
# 직전 서비스 단위와 ACL을 복원하고 daemon-reload 후 WAL 가드·API·AI를 재가동한다.
# 03시 전용 타이머를 disable하고, 직전 수집 타이머만 다시 켠다.
```
