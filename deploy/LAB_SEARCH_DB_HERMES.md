# 헤르메스 전달문 — 실험실 종목검색 DB개선

ATLAS 저장소 `https://github.com/swon218/AT`의 `main`에서 커밋 메시지가 `실험실 종목검색 DB개선`인 변경을 웹과 VPS에 반영해 주세요. GitHub push와 실제 운영 반영은 구분해서 보고해 주세요.

## 변경과 보존 범위

- `/api/public/lab/symbols`는 SQLite의 `symbols`에서 종목코드·이름·시장만 읽습니다. 기존 전체 일봉의 개수·최초일·마지막 날·품질 오류 집계를 제거했습니다. 마지막 수집 실행 정보(`runs` 최신 1행)는 유지합니다.
- 목록의 `ready`는 검색할 종목 목록이 있다는 뜻입니다. `bars`, `first_date`, `last_date`, 종목별 `corrected`/`quarantined`는 목록에서 제거되었습니다. 이전 웹은 이 필드에 의존하므로 웹과 VPS를 같은 변경으로 맞춰야 합니다. 검색 목록은 앞으로 모든 종목을 선택할 수 있으며, 실제 미수집 여부는 선택한 종목의 일봉 응답에서 안내합니다.
- 실험실 진입마다 기존 키움 공개 순위 API `type=realtime&limit=1`로 첫 종목을 정합니다. 순위 선택에만 키움을 사용하며 캔들은 `/api/public/lab/candles?symbol=선택코드`로 저장된 SQLite 일봉만 읽습니다. 삼성전자 고정 초기 선택과 목록 순서에 따른 종목 대체를 제거했습니다.
- 순위 응답이 늦게 도착해도 사용자가 먼저 검색한 종목을 덮어쓰지 않습니다. 순위 조회가 실패해도 검색으로 종목을 선택할 수 있습니다. 1위 종목에 수집된 일봉이 없으면 해당 사실을 안내하며 다른 종목의 일봉을 대신 표시하지 않습니다.
- 수집기, SQLite 스키마, 보정·격리 정책, 기존 데이터와 이력, 백테스트 계산, 주식 주문 탭은 유지합니다. 21:00 / 03:00 Asia/Seoul 수집 일정과 DB/WAL/SHM 파일을 변경하지 마세요. DB 재생성·마이그레이션·재수집·환경 변수 추가는 필요하지 않습니다.

## VPS 반영

이번에는 Python 조회 코드가 변경되어 **VPS 반영이 필요**합니다. 실제 `atlas-api.service`의 사용자, 작업 디렉터리, 환경파일 경로와 수집 중 여부를 먼저 확인하세요. 환경파일 전체나 비밀값을 출력하지 마세요. `/opt/atlas`, `/var/lib/atlas/lab.sqlite`, `.venv-lab`은 기존 배포 설정의 경로이며 현재 운영 경로를 확인해 사용하세요.

```bash
systemctl show atlas-api.service -p WorkingDirectory -p User -p Group -p EnvironmentFiles
systemctl show atlas-lab-collect.service -p ActiveState -p SubState -p MainPID
systemctl list-timers atlas-lab-collect.timer --all --no-pager
```

수집 중이면 강제로 중지하지 말고 끝난 뒤 진행하세요. 실제 작업 디렉터리로 이동하고 저장소 소유자로 실행하세요. 로컬 수정이 있으면 덮어쓰지 말고 보고하세요. 아래 각 단계가 실패하면 중단하고 원인을 확인하세요.

```bash
cd /opt/atlas
sudo -u atlas git status --short
sudo -u atlas git rev-parse HEAD
sudo -u atlas git pull --ff-only origin main
sudo -u atlas git log -1 --oneline
sudo -u atlas /opt/atlas/.venv-lab/bin/python -m unittest discover -s lab -p 'test_*.py' -v
sudo -u atlas npm run test:server
sudo -u atlas npm run test:search
sudo -u atlas npm run build
sudo systemctl restart atlas-api.service
sudo systemctl is-active atlas-api.service
```

패키지 변경이 없으므로 정상 설치된 환경에서 재설치는 필요하지 않습니다. Node 재시작은 기존 60초 목록 캐시도 비웁니다. Node 재시작에 따른 API의 짧은 중단은 보고하세요. AI·수집·WAL guard·타이머 및 다른 서비스는 재시작하지 마세요. 웹은 같은 커밋을 포함한 Vercel 프로덕션 배포 성공을 확인하세요. VPS에서 정적 웹을 제공한다면 기존 방식으로 새 `dist`를 반영하세요.

## 운영 확인

1. 실제 API 포트(기존 기본 3000)로 health를 확인하고, 재시작 직후 캐시 없는 종목 목록 요청의 상태·시간·반환 종목 수를 기록하세요. 60초 이상 지난 다음 재조회 시간도 확인하세요. 503이나 `Lab database read failed` 로그가 있으면 완료라고 보고하지 마세요. 이 변경으로 모든 네트워크·디스크·권한 장애까지 없어지는 것은 아닙니다.

```bash
curl --fail --silent --output /dev/null --write-out 'health: %{http_code} %{time_total}s\n' http://127.0.0.1:3000/api/health
curl --fail --silent --output /dev/null --write-out 'symbols: %{http_code} %{time_total}s\n' http://127.0.0.1:3000/api/public/lab/symbols
```

2. 목록 각 행에 `code`, `name`, `market`만 있는지 확인하세요. `ready`를 전체 종목 일봉 수집 완료라는 뜻으로 해석하지 마세요. 기존 수집 실패 수나 실제 격리 경고는 숨기지 않습니다.
3. 운영 웹에서 실험실에 진입했을 때 그 시점의 키움 실시간조회 1위 종목이 선택되는지 확인하세요. 순위는 시점에 따라 바뀌므로 고정 종목명을 기대하지 마세요. 네트워크 요청에서 `rankings?type=realtime&limit=1`, `lab/symbols`, 해당 코드의 `lab/candles`를 확인하세요. 실험실 캔들을 증권사 캔들 API로 가져오면 안 됩니다.
4. `삼`, `sk`, `005930` 등으로 검색하고 Enter 또는 클릭으로 전환하세요. 글자를 입력할 때마다 외부 검색이나 일봉 조회를 하지 않고, 선택한 시점에 그 종목의 저장된 일봉만 요청해야 합니다. 검색 결과가 OHLC 표시 위에 가려짐 없이 나오는지도 확인하세요.
5. 두 종목을 빠르게 전환하고 마지막 선택의 종목명·코드·가격·일봉이 일치하는지 확인하세요. 새로고침은 현재 선택을 유지하며, 다른 탭으로 나갔다가 실험실에 다시 들어오면 새로 조회한 실시간조회 1위로 시작해야 합니다.
6. 미수집 종목은 선택 후 명시적인 안내가 나와야 합니다. 격리된 일봉은 빈 구간과 기존 품질 안내·백테스트 차단을 유지해야 합니다. 실제 사례가 없으면 해당 항목은 미확인으로 보고하세요.
7. 기존 주식 주문 탭의 차트·검색, 수집 타이머의 21:00/03:00 일정이 유지되는지 확인하세요. 주문 실행은 검증에 필요하지 않습니다.

## 로컬에서 확인한 내용

- Python 수집·저장 회귀 테스트 19개, 서버 77개, 공통 검색 17개, 프로덕션 빌드 통과.
- SQLite authorizer로 목록 조회가 `symbols`, `runs` 이외의 테이블을 읽거나 데이터를 쓰면 실패하도록 검사. 선택 종목별 가격과 품질 격리 분리 검증 통과.
- 별도 fixture DB의 2,727종목·3,335,121개 일봉에서 이전 목록 조회 1,170.53ms → 새 목록 조회 6.71ms, 선택 종목 1,223봉 조회 5.86ms. 조회 전후 DB 파일 SHA-256 동일. 운영 VPS 측정값이 아닙니다.
- Chrome에서 실제 `LabChartPanel`과 실제 Node→Python→fixture SQLite 경로로 첫 진입, 검색 선택, 재진입, 늦은 순위 응답, 늦은 이전 종목 일봉, 순위 실패 후 검색, 미수집 안내를 확인했습니다. 정상 상태에서 저장소 오류와 증권사 캔들 요청이 없었습니다.
- 브라우저 검증을 다시 실행하려면 `node tests/labBrowserHarness.js` 후 `http://127.0.0.1:15174/tests/labScope.html`을 여세요. 이 도구는 별도 임시 DB와 가짜 순위 응답을 쓰며 `.env`, 실제 키움·Supabase·운영 DB를 사용하지 않습니다. 검증용이며 운영 서비스에 설치하지 마세요.

보고할 내용: 반영 커밋, VPS/API와 웹 각각의 배포 상태, 캐시 없는 목록 조회 시간, 첫 선택 종목과 순위 일치 여부, 검색 전환과 실제 일봉 표시, 기존 수집 설정 유지 여부, 실패 로그 유무, 미확인 항목.
