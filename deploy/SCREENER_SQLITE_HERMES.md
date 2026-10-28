# SQLite 후속 수정: 읽기 계정과 WAL 수명

사용자가 전달한 **이번 수정 커밋 전체 해시**를 대상으로 진행하세요. 이 문서는 `SCREENER_VPS_HERMES.md`, `AI_AGENT_FOLLOWUP_HERMES.md`의 이전 읽기 파일 준비·재시작 지침보다 우선합니다. 아직 운영 배포 성공으로 보고하지 않습니다.

## 확인 사실과 변경

- 사용자 보고상 운영은 `d794a423...`이고 `a7abb937...`은 미반영입니다. 실제 HEAD와 서비스를 다시 확인하세요. 현재 HEAD가 대상 커밋의 **조상**인지 확인하는 방향은 `git merge-base --is-ancestor CURRENT TARGET`입니다. 새 대상이 옛 운영 HEAD의 조상일 필요는 없습니다.
- Windows에서 같은 SQLite DLL로 통과한 것만으로 Linux 호환성을 입증하지 못했습니다. 새 `.github/workflows/sqlite-linux.yml`은 Ubuntu 22.04 시스템 Python 3.10.12 / SQLite 3.37.2에서 실행합니다. 기존 47개는 그 Linux CI에서 통과했으므로 VPS의 네 실패를 ‘3.37.2이면 항상 발생’이라고 단정하지 않습니다. VPS의 실제 새 코드 결과를 반드시 확인하세요.
- fingerprint는 `sqlite-physical-commit-v2`입니다. 메인 DB ctime(권한/ACL), WAL의 크기·mtime·ctime·inode 자체는 commit ID로 사용하지 않습니다. 샘플을 읽는 도중의 stat 변화는 여전히 거부합니다. 실제 WAL salt/index/마지막 commit frame/page checksum과 메인 DB identity·size·mtime·header를 검증합니다.
- 검증된 WAL의 `nBackfill == mxFrame`이면 모든 commit이 DB에 반영된 상태이므로 WAL의 보존/소멸을 같은 상태로 정규화합니다. index가 없거나 깨졌거나 실제 commit이 경합하면 fail-closed를 유지합니다. 같은 크기·mtime의 실제 WAL commit도 회귀 검증합니다.
- 첫 reader의 pager 초기화는 fingerprint 기준점 전에 완료하며 실패한 연결은 정리합니다. `mode=ro`, `query_only`, snapshot 해제, 품질 정책과 12초 한도는 유지합니다.

## 필요한 운영 준비: DB 소유자 전용 WAL guard

WAL DB에서 sidecar가 없는 경우 읽기 계정에게 디렉터리 쓰기 권한이 없으면 정상적으로 읽을 수 없습니다. SQL 조건식의 문제가 아닙니다. 이를 AI 계정의 `mode=rw`, `immutable=1`, 권한 확대, 빈 WAL/SHM 수동 생성으로 우회하지 마세요.

새 `lab/wal_guard.py`는 **기존 DB 소유자 `atlas`**로 실행합니다(실제 소유자를 확인). 기존 WAL DB만 `mode=rw`로 열어 SQLite가 sidecar를 준비하게 하고, 즉시 `query_only=ON`과 SELECT/READ 전용 authorizer를 적용합니다. 데이터/DDL/체크포인트 SQL은 실행하지 않습니다. 기존 소유자가 가지던 권한이며 AI에 부여하지 않습니다.

연결만 유지하고 읽기 transaction은 유지하지 않아 수집 writer와 checkpoint가 진행될 수 있습니다. 정확한 `lab.sqlite-wal`, `lab.sqlite-shm` 두 파일에만 `atlas-ai:r--` ACL을 설정하고 기존 ACL mask를 재계산하지 않습니다. AI의 DB/디렉터리 쓰기 권한, 그룹, 다른 파일 권한은 바꾸지 않습니다. `wal_guard_acl_mask_requires_review`라면 broad chmod/default ACL로 우회하지 말고 해당 파일의 기존 ACL을 보고하세요. DB/sidecar의 교체·소유자 변경도 감지하면 중단합니다.

이는 새 보조 서비스 하나를 추가하는 수정입니다. 기존 수집 스케줄·데이터·정책은 바뀌지 않으며 2GB DB 복제도 하지 않습니다. SQLite가 보조 파일을 생성·관리하는 물리 동작과 두 파일의 읽기 ACL 설정은 필요합니다. 정상 연결 종료 시 SQLite 자체의 checkpoint가 일어날 수 있지만 종목 데이터 수정/재수집/보정은 하지 않습니다.

공식 근거: https://sqlite.org/wal.html#read_only_databases 및 https://sqlite.org/walformat.html#file_lifecycles .

## 운영 checkout 변경 전

1. 현재 HEAD/clean, 수집 실행 여부, 기존 서비스와 비공개 복구 지점을 보존하세요. 최신 원격 main 전체를 무조건 반영하지 말고 전달된 해시를 별도 worktree로 checkout하세요.
2. 테스트 환경에 잠금된 `ai_agent/requirements-test.lock`을 사용하고 `python -m pytest ai_agent/tests -q --tb=short`, Node 전체 테스트 및 build를 실행하세요. Linux 비관리자 테스트에서는 별도 UID 테스트 2개가 skip이며 이것을 실행 성공으로 세지 마세요. 별도 UID 회귀는 공개 Linux CI에서 root fixture runner가 **서로 다른 비관리자 writer/reader**로 실행합니다. 운영 DB gate의 실행자는 반드시 `atlas-ai`입니다.
3. 신규 guard의 표준 Ubuntu `setfacl` 유틸리티(`acl` 패키지)가 있는지 확인하세요. 없으면 명시된 운영 의존성으로 설치하고 기록하세요. SQLite/Python 패키지를 업그레이드하지 마세요.
4. 운영 수집이 유휴일 때만 격리 worktree의 guard를 기존 DB 소유자로 시작하세요. 임시 systemd unit을 사용할 수 있습니다. 아래 경로는 실제 worktree·가상환경·소유자를 확인한 뒤 대입하세요. Node/AI 환경파일은 읽거나 전달하지 마세요.

```sh
# WT는 새 수정 해시가 checkout된 검증용 절대 경로입니다.
# 해당 경로를 atlas가 읽고 실행할 수 있어야 합니다.
sudo systemd-run --unit=atlas-wal-preflight \
  --property=Type=notify --property=User=atlas --property=Group=atlas \
  --property=WorkingDirectory="$WT" --property=ProtectSystem=strict \
  --property=ReadWritePaths=/var/lib/atlas --property=NoNewPrivileges=true \
  --property=UMask=0027 --setenv=PYTHONDONTWRITEBYTECODE=1 \
  /opt/atlas/.venv-ai/bin/python -m lab.wal_guard \
  --db /var/lib/atlas/lab.sqlite --reader atlas-ai
```

`active`와 `WAL_READONLY_READY`를 확인하세요. 실패하면 운영 checkout/기존 서비스를 바꾸지 말고 원인을 보고합니다. 파일별 ACL 변경 전 상태는 비공개 복구 기록에 남겨 주세요. 새 helper의 metadata 준비만 허용되며 collector·API·AI 서비스를 먼저 재시작하지 않습니다.

5. 기존 `atlas-ai` 권한으로 DB/디렉터리가 계속 쓰기 불가이고 두 sidecar만 읽을 수 있는지 확인하세요. 실제 운영 파일에 UPDATE/DELETE를 시도해 확인하지 마세요. 그 쓰기 차단은 CI fixture로 검증하며 운영에서는 권한·mount 설정만 조회합니다.
6. 새 worktree에서 AI 사용자로 fingerprint CLI와 gate를 실행하세요.

```sh
# 아래 명령의 cwd는 WT입니다. Python/DB 경로는 실제 설정을 확인하세요.
sudo -u atlas-ai /opt/atlas/.venv-ai/bin/python -I -S \
  "$WT/ai_agent/snapshot_fingerprint.py" /var/lib/atlas/lab.sqlite
sudo -u atlas-ai /opt/atlas/.venv-ai/bin/python -m deploy.screener_gate \
  --db /var/lib/atlas/lab.sqlite
```

fingerprint CLI의 `components`는 값/행/header 원문이 아닌 component별 해시입니다. 실패하면 runtime, module 경로, cutoff, sidecar 접근 상태, 해당 해시와 정확한 예외·실패 테스트 이름을 보고하세요. 수집 commit과 겹치면 유휴 시점에 재검증하되 실패를 무조건 성공 처리하거나 기준일을 바꾸지 마세요. `SCREENER_READONLY_GATE_PASS` 전에는 배포 금지입니다.

## gate 통과 후에만

1. 운영이 clean이고 CURRENT→TARGET fast-forward 가능함을 확인해 전달된 커밋까지 반영하세요.
2. `deploy/atlas-lab-wal.service`를 새 unit으로 설치하고 경로/User/Group을 실제 값에 맞추세요. 기존 AI unit을 덮어쓰지 말고 `deploy/atlas-ai-wal.conf`를 `/etc/systemd/system/atlas-ai.service.d/30-lab-wal.conf`로 추가하세요. 다른 drop-in/환경파일은 보존합니다. 이 drop-in은 준비 순서만 추가하며 AI 권한은 바꾸지 않습니다.
3. daemon-reload 후 **영구 `atlas-lab-wal.service`를 먼저 enable/start**하고 Ready를 확인하세요. 영구 guard가 준비되기 전 임시 guard를 종료하지 마세요. 이후 `atlas-ai.service`, `atlas-api.service` 두 서비스만 순서대로 재시작합니다. paper/futures/tailscale/수집 및 cleanup timer는 재시작하지 않습니다.
4. 운영 cwd에서도 gate를 다시 통과시킨 뒤 임시 `atlas-wal-preflight.service`만 stop하세요. 임시 worktree는 그 프로세스가 완전히 종료된 뒤 정리합니다. 영구 guard를 중지하거나 운영 DB sidecar를 수동 삭제하지 마세요.
5. 실제 웹의 GET/POST `/api/screener`, RSI·BB·MA·AND/OR·페이지, 출처/기준일/제외 범위를 확인하세요. 프론트가 Ready라는 사실과 backend 배포 성공을 구분하세요.
6. 실패 시 기록한 이전 코드/AI drop-in을 복구하고 변경한 두 기존 서비스만 되돌리세요. 새 guard 제거가 필요하면 의존성과 실행 중 읽기 요청을 먼저 정리하고, 추가한 설정만 정리하세요. 기존 사용자 ACL을 임의 삭제하지 마세요.

Supabase SQL 재실행, API 키 설정, 실제 OpenAI 호출, 운영 데이터 재수집/보정/삭제, SQLite 업그레이드, 12초 제한/달력/격리 정책 변경은 계속 금지합니다.

보고: 최종 HEAD/clean, Linux 테스트와 별도 UID 테스트 결과, 실제 AI 사용자 gate 결과, guard/Node/AI 상태, Vercel 커밋, HTTP 조회, source cutoff/coverage 및 남은 문제. 비밀값이나 운영 데이터 행은 보내지 마세요.
