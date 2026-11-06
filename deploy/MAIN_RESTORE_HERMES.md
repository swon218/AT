# 헤르메스 전달문 · main 복구 및 대시보드 통합

**2026-11-07부터 기본 개발·푸시·배포 기준은 `main`입니다.** 이전 선별 배포 문서의 ‘main pull/merge 금지’ 및 `codex/dashboard-orders-only` 고정 지침은 이 복구 커밋 이후에는 적용하지 않습니다. 이전 문서들은 과거 배포 기록으로만 남깁니다. 사용자가 전달한 이번 최종 전체 SHA를 대조하세요.

## 완료한 저장소 정리

- `main`에 포함돼 있던 미완료 실험실 전환 두 커밋 `118aa1949c378530e2fe235f7e6923731cf9908b`, `ac85f2a5c19af07c34645026ec979978c8cd553e`를 역적용했습니다. reset·강제 push로 기록을 지우지 않았습니다.
- 대시보드 보유종목·최근 주문·조회 안정화·안내 문구 수정은 최신 선별 브랜치 `9bccfca37f4ff493c85691a5aa2718755df1feac`까지 모두 병합했습니다.
- 병합 직후 전체 Git 파일 내용이 `9bccfca`와 정확히 일치함을 확인했습니다. 이후 변경은 이 지침·README와 과거 배포 문서의 보관 안내뿐입니다. 실행 코드와 테스트는 `9bccfca`와 같습니다.
- 실험실 코드·수집 unit/timer 파일은 선별 배포 브랜치에서 사용하던 이전 버전입니다. 기존 collect timer의 21:00·03:00 KST 일정을 유지하고, 보류한 nightly 스테이징·confirm 게시·recovery 전환은 포함하지 않습니다.
- 운영 DB를 되돌리거나 삭제하는 작업은 하지 않았습니다. 45개 종목의 과거 일봉 품질 문제를 해결한 것으로 보고하지 마세요.

## 로컬 검증

```bash
npm run test:server
node --test tests/recentOrders.test.js tests/assetSummary.test.js
npm run build
# 각 프로젝트용 테스트 venv의 python을 사용
python -m unittest discover -s lab -p 'test_*.py'
python -m pytest ai_agent/tests/test_order_calendar.py ai_agent/tests/test_calendar_screener.py ai_agent/tests/test_stock_screen.py -q
```

서버 119/119, 프런트 관련 7/7, 실험실 unittest 19/19, 달력·조건검색 pytest 32/32 통과, 빌드 성공입니다. 실제 증권사·실주문·운영 DB 검증을 의미하지 않습니다. 운영 venv에 pytest를 추가하지 말고 필요하면 격리된 테스트 venv를 사용하세요.

## Vercel과 VPS 기준 정리

- Vercel은 `main` 푸시에 의한 **같은 최종 SHA의 Production 자동 배포**를 확인합니다. Preview만 Ready인 것을 운영 완료로 보고하지 마세요. 기존 환경변수·도메인은 유지합니다.
- 최신 Vercel 운영 `9bccfca`와 실행 코드가 같으므로 새 기능이나 화면 동작 변화가 있는 배포는 아닙니다. 앞으로 main으로 정상 작업하기 위한 Git 기준 정리입니다.
- VPS는 마지막 보고된 `250d53454aee56911672c520917a737ac2abd711` 기준으로 Node/Python/실험실 실행 코드가 이번 main과 같습니다. 프런트 코드·모의 테스트·문서만 추가 차이이므로 **이번 기준 정리만을 위해 서비스 재시작, SQL 마이그레이션, timer 재설치·비활성화, DB·환경파일 변경을 하지 마세요.** `atlas-api`, `atlas-ai`, 기존 수집 timer 상태를 유지합니다.
- VPS Git checkout도 main으로 정렬하려면 실제 서비스 경로·소유자·현재 SHA와 로컬 변경을 먼저 확인하고 기존 백업·환경파일·venv를 보존하세요. 운영 코드를 임의 복사하거나 별도 checkout으로 바꾸지 마세요. 승인 SHA가 현재 운영 HEAD의 후속인지 확인한 다음 기존 운영 checkout에서만 fast-forward로 반영합니다. 로컬 변경이 있거나 후속 관계가 아니면 강제 reset하지 말고 차이를 보고합니다.

```bash
git status --short
git rev-parse HEAD
git fetch origin main
git show -s --format='%H %s' "$DEPLOY_SHA"
git merge-base --is-ancestor HEAD "$DEPLOY_SHA"
git diff --name-status HEAD "$DEPLOY_SHA"
# DEPLOY_SHA는 사용자가 전달한 이번 main의 최종 전체 SHA
# 위 검증과 변경 범위 확인이 끝난 뒤, 현재 branch/detached 상태를 보존하며 정렬
git merge --ff-only "$DEPLOY_SHA"
```

이 명령은 현재 branch를 main으로 바꾸지 않습니다. 운영 checkout이 detached 또는 이전 선별 branch라면 후속 배포 도구의 원격 추적 대상을 `origin/main`으로 정리하고, branch 전환이 필요할 때는 실제 branch/worktree 상태를 확인해 진행하세요. 근거 없이 `git switch main`으로 과거 로컬 main을 서비스에 먼저 노출하지 마세요.

기존 운영 기준과의 실제 실행 코드 diff가 설명과 다르면 재시작·DB 작업을 자동으로 진행하지 말고 변경 경로를 보고합니다. `main` 정렬 완료 여부와 서비스/DB 보존, Vercel Production SHA·배포 ID를 분리해 최종 보고하세요. 이번 작업의 검증을 위해 증권사 개인 조회를 반복하거나 실주문을 보내지 마세요.
