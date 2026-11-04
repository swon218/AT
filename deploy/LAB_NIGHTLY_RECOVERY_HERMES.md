# 헤르메스 전달문 · 실험실 일봉 복구 및 수집 개선

배포 대상은 GitHub의 `실험실 일봉 복구 및 수집 개선` 커밋이다. 아래에서 전달받은 SHA를 사용하고, 운영 DB에서 후보가 실제 승인·게시됐는지는 결과로 별도 보고한다. 작업 위치는 `/opt/atlas`, 운영 DB는 `/var/lib/atlas/lab.sqlite` 기준이다.

## 데이터와 게시 규칙

- 21시 `primary`는 완료 KRX 거래일 D의 실제 목록을 고정하고 원본·판정·종목별 결과를 적재한다. 웹 가격은 이전 공개 버전을 읽는다.
- 03시 `confirm`은 전날 21시의 거래일 D를 달력으로 계산하고 저장된 대상 목록을 재사용한다. 미처리·실패를 먼저 조회하고, 21시 통과 결과는 저장 예정 데이터와 전체 기간을 확인한다. 필요하면 `--check-short`를 주어 최근 7일도 조회할 수 있다. 최근 겹치는 원본 값이 변하면 해당 종목은 전체 보존 기간을 다시 요청한다.
- 03시 작업이 끝나면 SQLite 트랜잭션 하나로 통과 종목의 공개 데이터를 갱신한다. 잔여 실패 종목은 마지막 사용 가능한 봉과 목표 날짜·실패 상태를 표시한다. 양쪽 모두 실패한 날은 이전 공개 데이터 기준일을 유지한다. 03시는 시작 시각이며 게시 시각은 API의 `published_at`이다.
- 보존 시작일은 `max(D의 5년 전, 확인된 상장일)`이다. 휴장일에는 직전 완료 거래일을 사용한다. 동일 거래일의 게시를 이미 마쳤으면 21시 작업은 생략되며, 03시 재실행은 남은 대상만 처리한다.
- 거래량 0, 종목 목록의 가격 열, 공급자의 날짜 생략만으로 거래정지를 추정하지 않는다. 출처에 맞는 무거래 근거 또는 별도 상장일 근거가 필요하면 아래 명령으로 등록한다.
- 새 운영 모드에서는 기존 `corrected`(1원 보정) 이력을 보존하되 해당 봉을 격리한다. 보존 구간에 이런 봉이 남아 있으면 종목은 품질 실패가 될 수 있다. 따라서 기존 진단의 45개 문제 종목보다 격리·실패 대상이 늘어날 수 있다. 운영 DB의 영향 규모는 로컬에서 미검증이며, 아래 VPS 복제본 검증은 운영 적용의 필수 조건이다. 새 값에 1원 보정이나 보간을 적용하지 않는다.
- 종료 코드는 `0` 전부 완료 또는 확인된 비거래, `2` 일부 실패·미처리, `1` 성공 대상 없음 또는 실행 장애다. systemd는 `2`를 허용하되 로그와 DB에는 실제 분류가 남는다.
- `exchange-calendars==4.13.2`와 저장소 KRX 검토 휴장일을 사용한다. 기본 검토 범위는 2026-12-31까지다. 다음 연도 달력·임시 휴장을 검토해 `LAB_CALENDAR_THROUGH`를 갱신한다. 범위를 넘기면 수집이 중단된다.

## 1. 실행 상태 기록, 예약 차단 및 SQLite 백업

```bash
LIVE=/opt/atlas
SHA='<전달받은 전체 커밋 SHA>'
PREV_SHA=$(git -C "$LIVE" rev-parse HEAD)
LIVE_PY="$LIVE/.venv-lab/bin/python"
DB=/var/lib/atlas/lab.sqlite
DIAG='<VPS 진단 CSV와 보고서가 있는 디렉터리>'
WORK=$(mktemp -d /var/tmp/atlas-lab-cutover.XXXXXXXX)
sudo chgrp atlas "$WORK"
chmod 0750 "$WORK"
sudo install -d -o atlas -g atlas -m 0750 "$WORK/db"
units=(atlas-lab-collect.timer atlas-lab-collect.service atlas-lab-confirm.timer atlas-lab-confirm.service atlas-lab-wal atlas-api atlas-ai)
{
  printf 'live=%s\nprevious_sha=%s\ncandidate_sha=%s\n' "$LIVE" "$PREV_SHA" "$SHA"
  git -C "$LIVE" status --short
  systemctl list-timers 'atlas-lab-*'
  systemctl show "${units[@]}" -p Id -p LoadState -p ActiveState -p SubState -p UnitFileState \
    -p FragmentPath -p DropInPaths -p Result -p ExecMainCode -p ExecMainStatus
} > "$WORK/preflight.txt"
(umask 077; "$LIVE_PY" -m pip freeze > "$WORK/previous-lab-requirements.txt")
sudo getfacl -p /var/lib/atlas "$DB" > "$WORK/db.acl"
# 직전 단위와 드롭인 정의를 권한 제한 파일에 기록한다. 내용을 로그로 출력하지 않는다.
for unit in "${units[@]}"; do
  if [ "$(systemctl show "$unit" -p LoadState --value)" = loaded ]; then
    (umask 077; sudo systemctl cat "$unit" > "$WORK/$unit.definition")
  fi
done

# 기존 실행은 건드리지 않고 다음 예약만 중단한다.
sudo systemctl stop atlas-lab-collect.timer
if [ "$(systemctl show atlas-lab-confirm.timer -p LoadState --value)" = loaded ]; then
  sudo systemctl stop atlas-lab-confirm.timer
fi
systemctl list-timers 'atlas-lab-*'
deadline=$((SECONDS + 16200))
drained=1
for service in atlas-lab-collect.service atlas-lab-confirm.service; do
  while [[ "$(systemctl show "$service" -p ActiveState --value)" =~ ^(activating|active|deactivating|reloading)$ ]]; do
    if (( SECONDS >= deadline )); then echo "종료 대기 한도 초과 · $service"; drained=0; break; fi
    sleep 15
  done
  systemctl show "$service" -p ActiveState -p SubState -p Result -p ExecMainCode -p ExecMainStatus
done > "$WORK/drain.txt"
cat "$WORK/drain.txt"
test "$drained" = 1
```

예약이 중단됐고 실행 중이던 수집 프로세스가 정상 종료됐음을 상태와 로그에서 확인한다. 종료 대기 초과, 강제 종료, 비정상 종료 또는 실행 상태가 모호하면 백업·전환을 진행하기 전에 원인을 확인한다. 기존 품질 경고 종료 코드는 해당 배치 로그로 구분한다. 운영 작업트리 상태와 이전 프런트 배포 SHA 또는 배포 ID도 기록한다.

```bash
BACKUP="$WORK/db/baseline.sqlite"
REHEARSAL="$WORK/db/rehearsal.sqlite"
sudo -u atlas "$LIVE_PY" - "$DB" "$BACKUP" "$REHEARSAL" <<'PY'
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
```

백업은 SQLite backup API로 만든다. WAL 모드 운영 중인 DB 파일 하나만 복사하면 커밋된 최신 데이터가 빠질 수 있다. 기존 WAL 가드 및 읽기 전용 ACL도 유지한다.

## 2. 격리된 체크아웃에서 후보 검증·승인

운영 체크아웃과 운영 가상환경을 그대로 둔 채 별도 환경에서 배포 SHA를 리허설한다.

```bash
WORKTREE="$WORK/candidate"
umask 022
git clone --no-checkout https://github.com/swon218/AT.git "$WORKTREE"
git -C "$WORKTREE" checkout --detach "$SHA"
test "$(git -C "$WORKTREE" rev-parse HEAD)" = "$SHA"
"$LIVE_PY" -m venv "$WORK/lab-venv"
PY="$WORK/lab-venv/bin/python"
cd "$WORKTREE"
"$PY" -m pip install -r lab/requirements.txt
npm ci
npm run build
sudo -u atlas "$PY" lab/collect.py --db "$REHEARSAL" --migrate-only
```

진단 디렉터리에는 `problem_candles.csv`, `source_comparison_recovery.csv`, `recovery_candidates.csv`, `trial_candidate_validation.csv`, `source_basis_and_limits.csv`, `diagnostic_report.md`가 필요하다. 세부 값과 현재 원본 source/hash/policy가 맞고 보존 기간 안에 있는 C 후보만 등록한다. 출력의 `reconstruction_review`는 기간 재구성 검토 목록이다.

```bash
sudo -u atlas "$PY" lab/recovery.py --db "$REHEARSAL" import-candidates "$DIAG"
sudo -u atlas "$PY" lab/recovery.py --db "$REHEARSAL" import-candidates "$DIAG" --register
```

관리자 키움 읽기 전용 조회에 사용하는 기존 자격 증명은 VPS 비밀 관리 절차로 `/etc/atlas/lab-kiwoom.env`에 연결한다. root가 읽는 별도 권한 제한 파일에 `KIWOOM_APP_KEY`, `KIWOOM_SECRET_KEY`와 필요한 경우 `KIWOOM_API_HOST`만 둔다. 앱 로그나 명령행에 값을 넣지 않는다. 조회 프로세스는 OAuth 발급과 `ka10081` 일봉만 사용한다.

```bash
broker_job() {
  sudo systemd-run --wait --pipe --collect -p User=atlas -p Group=atlas \
    -p "WorkingDirectory=$WORKTREE" -p EnvironmentFile=/etc/atlas/lab-kiwoom.env \
    -p 'Environment=DOTENV_CONFIG_PATH=/dev/null PYTHONDONTWRITEBYTECODE=1' -- "$@"
}
ID='<import-candidates 출력에서 검토한 candidate ID>'
broker_job "$PY" lab/recovery.py --db "$REHEARSAL" approve "$ID"
CODE='<검토한 종목코드>'
sudo -u atlas "$PY" lab/store.py --db "$REHEARSAL" --symbol "$CODE"
```

`accepted=true`를 확인한다. CLI는 현 DB의 양쪽 정상 5봉씩과 복구 후보 1봉을 지정된 키움 기준에서 재조회해 OHLCV를 비교한다. 승인·검증·원본 판정·실제 적용을 각각 이력으로 남긴다. 기준이 달라지거나 양쪽 5봉을 확보하지 못하면 적용되지 않는다. 같은 오류 원본과 주변 기준이 유지되면 다음 수집에서도 복구를 보존한다. 겹치는 과거 원본이 바뀌면 해당 종목을 전체 재검증하고, 영향이 확인된 복구는 보류한다. 늦게 소급된 정정이 최근 조회 구간 밖에만 있다면 별도 전체 재검증이 필요하다.

## 3. 종목별 기간 재구성

진단 D 분류와 전환 점검에서 추가로 격리된 종목을 이 절의 검토 대상에 포함한다. `legacy_corrected`, `newly_quarantined`, `newly_failed`, `lost_usable`로 대상과 원본 식별값을 확인한다. 기존 `corrected`는 원천에서 정상 봉을 받아 동일 기준으로 검증되면 재수집으로 복구한다. 원천 값이 계속 불량하거나 기준이 일치하지 않으면 종목별 보존 기간을 일관된 기준으로 재구성한다. 기존 C 후보 CSV에 해당 봉을 임의로 추가하지 않는다.

종목마다 상장일, 조정과 거래량 기준, 시장 범위를 확정하고 `basis.json`에 검토자, 근거, 독립 참조 OHLCV를 기록한다. 적어도 2봉을 넣고 기업행위 전후 등 비교가 필요한 구간에서 선택한다. 아래 구조의 문자열과 값은 예시이므로 실제 근거로 바꾼다.

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

## 4. 복제본 게시 리허설 및 필수 통과 기준

```bash
broker_job "$PY" lab/nightly.py primary --db "$REHEARSAL" --max-minutes 250
# 두 명령의 JSON target이 같은지 확인한다. 실제 시각은 아래 스케줄 기준이다.
broker_job "$PY" lab/nightly.py confirm --db "$REHEARSAL" --max-minutes 240
sudo -u atlas "$PY" lab/store.py --db "$REHEARSAL" |
  "$PY" -c 'import json,sys; print(json.dumps(json.load(sys.stdin).get("publication"), indent=2))'
TARGET='<두 배치에서 확인한 동일 거래일 YYYY-MM-DD>'
gate_status=0
sudo -u atlas "$PY" -m deploy.lab_transition_gate --before "$BACKUP" --after "$REHEARSAL" \
  --target "$TARGET" > "$WORK/transition.json" || gate_status=$?
"$PY" -c 'import json,sys; r=json.load(open(sys.argv[1])); print({k:r.get(k) for k in ("passed","errors","window","before","after","delta","confirm_counts")})' "$WORK/transition.json"
test "$gate_status" = 0
```

수동 리허설에서 같은 D를 원하면 21시 전에 두 명령을 실행하거나, 21시 1차 실행 뒤 다음 날 03시 이후 확인한다. `--target YYYY-MM-DD`는 현재 공개 기준일보다 오래되지 않은 기존 완료 거래일 배치를 재개할 때 사용한다. 21시 전후의 표본 종목 조회 응답에서 일봉이 그대로인지 확인하고, 03시 게시 뒤 통과 종목과 잔여 실패 종목을 각각 확인한다. 승인 후보를 포함한 복제본에서 재수집 후 원본과 복구의 식별값, 재구성 종목의 후속 키움 원천도 확인한다.

게이트는 두 DB를 읽기 전용으로 열고 동일한 D 기준 최근 5년을 비교한다. 사용 가능 봉은 API에서 격리되지 않는 저장 봉이며, 격리 봉에는 가격 행 없이 격리로 표시되는 날짜도 포함한다. 실패 종목은 전환 전에는 `symbols.error` 또는 공개 격리가 있는 종목, 전환 후에는 03시 미완료·실패 상태 또는 공개 격리가 있는 종목이다. 직전 레거시 배치의 집계는 별도로 출력한다. 신규·제외 종목을 따로 출력하므로 실제 목록 변동과 검증 실패를 구분할 수 있다.

**운영 진행 조건**

- 두 SQLite의 `quick_check` 및 복제본의 외래키 검사가 통과해야 한다. 21시·03시가 같은 D에서 완료됐고 21시·03시·공개 상태·활성 종목의 대상이 일치해야 한다. 공개 집계가 실제 상태와 맞고, 완료된 종목에는 D의 사용 가능한 봉이 있어야 한다. 활성 종목의 저장 봉은 최근 5년 및 확인된 상장일 이후 범위 안에 있어야 한다.
- 계속 활성인 종목에서 이전에 사용 가능했던 봉이 사라진 날짜, 새 격리 봉, 새 실패 종목이 각각 0이어야 한다. 전체 봉 수가 증가해도 특정 날짜 손실은 실패다. 추가·제외 종목이 있다면 KRX 대상 목록으로 사유를 확인한다.
- `transition.json`의 `passed=true`와 종료 코드 0이 필요하다. 실패 시 운영 적용을 중단하고 3절에서 추가 대상을 원천 대조·재수집 또는 기간 재구성으로 처리한 뒤 같은 기준으로 다시 실행한다. 기존 미해결 종목과 이유는 결과에 남긴다. 운영 DB에서 늘어날 실제 규모는 이 보고서가 생성되기 전까지 미확인이다.
- 복원도 운영 전 복제본에서 연습한다. 아래 명령은 변경 전 백업을 별도 파일로 복원해 무결성과 기준 테이블의 행 수를 확인한다.

```bash
RESTORED="$WORK/db/rollback-drill.sqlite"
sudo -u atlas "$PY" - "$BACKUP" "$RESTORED" <<'PY'
import sqlite3, sys
from contextlib import closing
from pathlib import Path
backup, restored = map(Path, sys.argv[1:])
assert backup.is_file() and not restored.exists()
with closing(sqlite3.connect(backup.resolve().as_uri() + '?mode=ro', uri=True)) as src:
    with closing(sqlite3.connect(restored)) as dst:
        src.backup(dst)
        assert dst.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
        for table in ('symbols', 'candles', 'candle_quality', 'raw_candles'):
            sql = f'SELECT count(*) FROM {table}'
            assert src.execute(sql).fetchone() == dst.execute(sql).fetchone()
PY
```

## 5. 운영 반영 및 실제 게시 확인

4절을 통과한 SHA와 보고서를 확인한 뒤에만 실행한다. 리허설 중 운영 DB에 수집 쓰기가 발생했거나 운영 SHA·설정이 달라졌다면 기준을 다시 확보한다.

```bash
test "$(git -C "$WORKTREE" rev-parse HEAD)" = "$SHA" &&
  "$PY" -c 'import json,sys; assert json.load(open(sys.argv[1]))["passed"] is True' "$WORK/transition.json" &&
  test -f "$RESTORED" || { echo '복제본 전환 검증 또는 복원 리허설 미통과'; exit 1; }
cd "$LIVE"
test "$(git rev-parse HEAD)" = "$PREV_SHA"
test -z "$(git status --porcelain)"
git fetch origin main
git merge --ff-only "$SHA"
test "$(git rev-parse HEAD)" = "$SHA"
WORKTREE="$LIVE"
PY="$LIVE_PY"
"$PY" -m pip install -r lab/requirements.txt
```

1. `lab/collect.py --db "$DB" --migrate-only`로 스키마를 추가한다.
2. 운영 DB를 대상으로 2절의 후보 확인·승인 및 3절의 검토 완료 작업만 다시 실행한다. 명령의 DB 인수에 `"$DB"`를 사용한다. 운영 원본과 대조 결과가 복제본과 다르면 중단한다.
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

첫 운영 03시 작업이 끝나면 실제 서비스 API에서 확인한다. 테스트용 파일을 읽은 출력만으로 운영 게시를 판정하지 않는다.

```bash
API_BASE='<실제로 서비스하는 ATLAS API 주소>'
curl -fsS "$API_BASE/api/public/lab/symbols" > "$WORK/live-symbols.json"
OK_CODE='<03시 완료 표본>'
FAIL_CODE='<잔여 실패 표본>'
curl -fsS "$API_BASE/api/public/lab/candles?symbol=$OK_CODE" > "$WORK/live-complete.json"
# 잔여 실패가 있으면 실행한다.
curl -fsS "$API_BASE/api/public/lab/candles?symbol=$FAIL_CODE" > "$WORK/live-incomplete.json"
/opt/atlas/.venv-ai/bin/python -m deploy.screener_gate --db "$DB"
```

API의 공개 버전·D·완료 시각·집계를 확인한다. 완료 표본의 최신일은 D여야 한다. 실패 표본에는 미완료 사유와 마지막 정상 날짜가 있어야 한다. 실제 웹에서도 공개 기준일, 최신 봉, 실패 안내, 복구 적용 내역을 확인하고 백테스트 JSON 및 조건검색의 버전이 API와 일치하는지 대조한다. 기존 45개 외에 새 격리나 실패가 나타나면 복제본 결과와 차이를 확인하고 아래 절차로 복원할 수 있는지 점검한다.

## 6. 철회와 롤백

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
sudo setfacl --restore="$WORK/db.acl"
sudo -u atlas "$LIVE_PY" -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); assert c.execute("PRAGMA integrity_check").fetchall()==[("ok",)]' "$DB"
```

배포 기록의 직전 SHA·가상환경 의존성·서비스 단위와 드롭인·프런트 배포를 복원한다. 새 단위를 제거할지는 배포 전 `LoadState`에 따라 결정한다. `daemon-reload` 후 WAL 가드, API, AI를 재가동하고 기록된 이전 타이머 상태를 복원한다. 실제 API와 웹에서 이전 일봉·출처·실패 표시가 돌아왔는지 확인하고, 보관 경로에 전환 이후 DB와 사이드카가 남아 있는지 확인한다.
