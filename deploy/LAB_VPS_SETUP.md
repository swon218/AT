# ATLAS 실험실 배포 안내

## 이번 구현 범위

- 가운데 과거 일봉 캔들·거래량·보조지표, 오른쪽 기존과 동일한 지표 설정.
- 개인/관리자 키움·토스 API를 사용하지 않는 별도 역사 데이터 경로.
- FinanceDataReader → VPS SQLite → 기존 Fastify API → 웹 차트.
- MA, 볼린저, 거래량 MA, RSI, MACD 조건을 AND/OR로 조합하는 일봉 백테스트.
- 비용 후 수익률, 일별 평가자산, 최대 낙폭, 청산 거래·승률, 미청산 보유, 거래 내역, 재현용 JSON 내보내기.
- Supabase 전략 SQL·저장·공유는 요청에 따라 보류. 두 탭의 지표 초안은 별개이며 새로고침 시 초기화된다. 실험실의 조건은 앱 내 탭 이동 동안 유지된다.

## 데이터 출처와 현재 확인한 제한

2026-09-28 로컬 검증에서 FDR 0.9.202의 `KRX:005930` 직접 경로는 `400 Bad Request (Period is up to 2 years)`로 실패했다. 한 달 요청도 동일해 실제 5년 한도 문제라고 단정하지 않는다. [FDR 공식 저장소의 동일 오류 보고](https://github.com/FinanceData/FinanceDataReader/issues/269)도 있다.

기본 수집은 정상 동작을 확인한 `fdr.DataReader('NAVER:종목코드', 시작일, 종료일)`이다. 삼성전자·SK하이닉스 각각 2021-09-28~2026-09-28 일봉 1,223개를 로컬 SQLite에 저장했다. 출처는 `FDR:NAVER`로 기록한다. [FDR 공식 사용법](https://github.com/FinanceData/FinanceDataReader)은 기본 국내 종목 조회가 네이버 경로임을 설명한다.

NXT 전용 또는 통합 시세를 별도로 수집하지 않는다. 다만 FDR의 네이버 응답에는 KRX/NXT 세션 구분 필드가 없으므로 **전 기간이 KRX 단독과 완전히 동일하다는 검증은 아직 하지 못했다.** 화면에 이를 알리고 출처를 명시했다. KRX 단독을 엄격하게 보장해야 하는 연구에서는 제공처 데이터 계약/기준을 확인하거나 KRX 직접 경로가 복구된 뒤 별도로 검증해야 한다. 직접 경로는 `--source KRX --full`로 선택할 수 있지만 현재 성공을 보장하지 않는다. 다른 출처로 조용히 대체하거나 기존 출처와 이어 붙이지 않는다.

FDR은 기간을 지정해 외부 제공처에서 데이터를 읽는 라이브러리이며 확정 갱신 시각·가용성을 보장하지 않는다. 매일 두 번 수집하고 최근 60일을 다시 확인한다. 가격 정정이 발견되면 전체 5년을 다시 받고 매주 일요일에도 전체를 갱신한다. 신규상장주는 실제 존재하는 기간만 제공한다. 제공되지 않는 봉을 만들어 채우지 않는다.

## VPS에서 실행할 작업

아래는 기존 배포 기록의 `/opt/atlas`, 사용자 `atlas`, 서비스 `atlas-api`를 기준으로 작성했다. 이번 작업에서 VPS에 SSH 접속하거나 배포하지 않았다. 경로가 바뀌었다면 실제 경로로 수정한다.

### 1. 변경한 소스 반영

GitHub에 반영된 실험실 변경을 아래 순서로 VPS에 배포한다. 작업 전 현재 브랜치, 로컬 수정 여부, 기존 서비스 실행 경로를 확인하고 로컬 수정이 있으면 덮어쓰지 않는다.

- 웹: `src/` 변경 파일 전체.
- 백엔드: `server/index.js`, `server/lab.js`, 기존 `server/` 파일 유지.
- 수집기: `lab/` 전체.
- 운영: `deploy/atlas-lab-collect.service`, `deploy/atlas-lab-collect.timer`.

GitHub 반영 후 VPS:

```bash
cd /opt/atlas
sudo -u atlas git pull --ff-only
```

Vercel에도 같은 프런트엔드 소스가 배포되어야 한다. 기존 `VITE_API_BASE_URL`은 VPS API 주소 그대로 사용한다. 새 도메인·포트·브로커 키는 필요하지 않다.

### 2. Python 환경과 DB 디렉터리 준비 (Ubuntu/Debian)

Python 3.10 이상을 사용한다. Node는 기존 프로젝트 요구 버전을 유지한다.

```bash
sudo apt-get update
sudo apt-get install -y python3 python3-venv sqlite3
cd /opt/atlas
sudo -u atlas python3 -m venv /opt/atlas/.venv-lab
sudo -u atlas /opt/atlas/.venv-lab/bin/python -m pip install -r /opt/atlas/lab/requirements.txt
sudo install -d -o atlas -g atlas -m 0750 /var/lib/atlas
```

SQLite는 별도 DB 서버나 유료 Supabase 요금제 없이 VPS 디스크에 저장한다. DB 파일은 `/var/lib/atlas/lab.sqlite`다. Git·Vercel에 올리지 않는다. 운영 중에는 `-wal`, `-shm` 보조 파일도 사용하므로 DB 디렉터리를 함께 유지한다.

### 3. 기존 API 서비스에 DB 경로 연결

기존 `/etc/atlas/atlas.env`에 다음 두 항목을 추가하거나 수정한다. 기존 비밀키나 다른 설정을 덮어쓰지 않는다.

```dotenv
LAB_DB_PATH=/var/lib/atlas/lab.sqlite
LAB_PYTHON=/opt/atlas/.venv-lab/bin/python
```

```bash
sudoedit /etc/atlas/atlas.env
sudo systemctl restart atlas-api
curl -fsS http://127.0.0.1:3000/api/public/lab/symbols
```

초기에는 `ready: false`가 정상이다. `503`이면 `journalctl -u atlas-api -n 60 --no-pager`에서 Python 경로·DB 권한을 확인한다. API 서비스 사용자도 DB를 읽고 SQLite WAL을 열 수 있어야 한다. 기본 안내는 수집기와 API 모두 `atlas` 사용자다.

### 4. 두 종목으로 확인 후 전 종목 초기 수집

```bash
sudo -u atlas /opt/atlas/.venv-lab/bin/python /opt/atlas/lab/collect.py \
  --db /var/lib/atlas/lab.sqlite --symbols 005930,000660 --full
curl -fsS 'http://127.0.0.1:3000/api/public/lab/candles?symbol=005930'
```

웹 실험실에서 삼성전자/하이닉스 차트, 출처, 수집일, 첫/마지막 일봉을 확인한다. API 캐시는 최대 1분이다. 수집 직후 이전 상태가 보이면 1분 후 새로고침한다.

아래 서비스 설치 후 서비스를 한 번 실행하면 **현재 상장된 KOSPI/KOSDAQ 종목 전체**를 초기 수집한다. KONEX·ETF·상장폐지 종목을 모두 포함하는 데이터셋은 아니다. 인터넷 상태와 종목 수에 따라 수십 분~수 시간이 걸릴 수 있다. API는 이미 저장된 종목부터 읽을 수 있다.

### 5. 야간 자동 갱신 설치

```bash
sudo install -m 0644 /opt/atlas/deploy/atlas-lab-collect.service /etc/systemd/system/atlas-lab-collect.service
sudo install -m 0644 /opt/atlas/deploy/atlas-lab-collect.timer /etc/systemd/system/atlas-lab-collect.timer
sudo systemctl daemon-reload
sudo systemctl enable --now atlas-lab-collect.timer
sudo systemctl start --no-block atlas-lab-collect.service
sudo systemctl list-timers atlas-lab-collect.timer
sudo journalctl -u atlas-lab-collect.service -f
```

한국시간 **21:00 / 03:00** 실행한다. 각 실행은 약 4시간 20분 내에서 미완료·오래된 종목부터 처리하고 서비스는 최대 4시간 30분으로 제한되어 정기 실행은 07:30 이전 종료된다. 업데이트 지연·실패는 다음 실행에서 재시도한다. 제공처 장애로 데이터가 아침까지 확보되지 않을 수 있으므로 화면은 실제 마지막 일봉과 오류를 표시한다. 원본 제공처보다 빠르게 당일 봉을 만들어낼 수는 없다.

`Persistent=false`여서 놓친 타이머가 재부팅 직후 장중에 자동 실행되지는 않는다. 필요하면 관리자가 직접 서비스를 실행한다. 수집기는 20시 이전 실행 시 전날까지 조회하여 당일 진행 중 봉을 저장하지 않는다. 휴장일에는 새 봉을 만들지 않는다. 수집 실패가 하나라도 있으면 서비스가 실패로 표시되지만 성공 종목은 유지되고 다음 타이머는 계속 실행된다.

수집기는 OS 파일 잠금으로 중복 실행을 차단한다. 서비스 실행 중 수동 CLI를 겹쳐 실행하지 않는다. 수집 서비스에는 증권사/사용자 비밀키 환경파일을 넣지 않는다.

### 6. 상태와 백업

```bash
sudo systemctl status atlas-lab-collect.timer
sudo journalctl -u atlas-lab-collect.service -n 50 --no-pager
sudo -u atlas sqlite3 /var/lib/atlas/lab.sqlite \
  'SELECT code, COUNT(*), MIN(date), MAX(date) FROM candles GROUP BY code LIMIT 10;'
sudo -u atlas sqlite3 /var/lib/atlas/lab.sqlite \
  ".backup '/var/lib/atlas/lab-backup.sqlite'"
```

백업은 SQLite `.backup`으로 일관된 복사본을 만든다. 실행 중인 WAL DB 파일 하나만 복사하지 않는다. 복구할 때는 API/수집 서비스를 중지한 상태에서 수행한다. DB를 새로 만드는 대신 원본 파일·백업을 보존한다.

## 백테스트 계산 범위

- 매수/매도 조건은 완성된 당일 일봉에서 확인하고 다음 저장된 거래일 시가에 체결한다. 시작일 이전 신호로 최초 매수하지 않는다.
- 지표 준비 기간은 저장된 과거 봉으로 계산한다. 부족하면 거래를 시작하지 않는다.
- 보유 중 추가 매수·공매도·레버리지 없음. 매수는 가용 현금 내 정수 수량, 매도는 전량.
- 매수/매도 각각 수수료, 매도세, 불리한 방향의 슬리피지를 반영한다. 화면 비용 기본값은 예시이며 실제 계좌·과거 기간별 비용표가 아니다.
- 시가/거래량이 0인 날은 주문을 체결하지 않고 대기 신호를 취소한다. 마지막 봉의 신호도 다음 봉 없이 체결하지 않는다.
- 종료일 미청산 포지션은 종가로 평가하고 거래 승률에 넣지 않는다. 평가자산에는 아직 발생하지 않은 청산 비용을 차감하지 않는다.
- 수정주가 기반 연구로 실제 당시 주식 수·현금배당·기업행동을 완전히 재현하지 않는다. 호가 잔량/거래대금 참여율/상하한가 미체결·시장 충격을 모델링하지 않는다.
- 현재 상장 종목 중심 데이터에는 생존편향이 있다. 단일 종목 과거 성과는 실거래 성과 보장이 아니다.

## 로컬 검증 명령

```powershell
npm run build
npm run test:server
.\.venv-lab\Scripts\python.exe -m unittest discover -s lab -p 'test_*.py' -v
```

Windows 로컬 기본 DB는 `data/lab.sqlite`, 기본 Python은 `.venv-lab/Scripts/python.exe`다. VPS 환경변수 예제를 그대로 로컬 `.env`에 복사하지 않는다. 실제 API는 `npm run dev:api`, 웹은 `npm run dev:web`로 실행한다. SQLite 조회 브리지는 Python 표준 라이브러리만 사용하며, FDR은 수집 프로세스에서만 로드된다.
