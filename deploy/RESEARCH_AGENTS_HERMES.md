# Market Data + Fundamental Research 통합 VPS 반영

Market Data Agent: `6855ce545df4cd7823e533953378907eb12683f4`.
최종 대상은 이 문서를 포함한 `Fundamental Research Agent` 커밋의 전체 SHA이며 최종 전달문에 실제 값을 기재한다. 첫 커밋만 따로 운영 반영하지 않는다.

1. `/opt/atlas`에서 현재 전체 SHA를 복구 기준으로 기록하고 clean 상태·현재 브랜치/detached 여부를 확인한다. `git fetch origin main` 후 최종 대상이 origin/main에 포함되고 현재 운영 HEAD의 후속인지 검사한다. 다른 작업은 보존한다. 서비스의 실제 User/WorkingDirectory/ExecStart/EnvironmentFiles/drop-in 이름을 확인하되 환경 본문·비밀값은 출력하지 않는다. 기준 경로는 API `/etc/atlas/atlas.env`, AI `/etc/atlas/ai.env`, 평가 `/etc/atlas/eval.env`, Python `/opt/atlas/.venv-ai/bin/python`, AI loopback 8010이다. 실제 API 포트는 unit에서 확인한다.
2. 기존 인증된 운영 도구로 분석 running, 평가 queued/running/live 대기 건수와 수집 상태만 읽는다. 기존 요청은 완료를 기다리고 평가 worker는 현재 작업을 마친 뒤 정상 중지한다. live 대기 평가를 이번 검증에서 임의로 소비하지 않는다. 승인 대기 카드·대화·평가 이력은 보존한다. Supabase private 스키마를 REST에 노출하지 않는다. 직접 집계가 불가능하면 필요한 집계만 DB 담당자에게 한 번에 요청한다.
3. **Supabase 추가 SQL 불필요.** 기존 DART·AI·평가·관심종목·알림 SQL 재실행, 데이터 초기화, checkpoint 준비를 하지 않는다. 기존 JSON 저장 구조와 DART 테이블을 그대로 쓴다.
4. 대상 SHA의 격리 worktree/테스트 venv에서 `npm ci`, 해시 검증된 `ai_agent/requirements-test.lock` 설치 후 다음 검사를 한다. Node와 Python 전체 검사를 동시에 무겁게 실행하지 말고 순차 진행한다. 통합 검사에는 `AI_TEST_PYTHON`을 격리 Python으로 지정한다.

   ```sh
   python -m pytest ai_agent/tests -q -rs
   node --test server/agent.test.js server/agentWatchlist.test.js server/adminEval.test.js server/agentMarketData.test.js server/agentFundamentalData.test.js server/companyDart.test.js server/stockSearch.test.js tests/agentWorkspace.test.js tests/agentSources.test.js
   node --test --test-concurrency=1 tests/agentIntegration.test.js tests/marketAgentIntegration.test.js tests/fundamentalAgentIntegration.test.js tests/screenerIntegration.test.js
   npm run build
   ```

   실제 모델·운영 회원·발송·주문은 사용하지 않는다. 운영 venv에 pytest를 설치하지 않는다. 기존 Linux UID/WAL read-only gate도 보존한다.
5. 현재와 대상의 package/requirements 잠금파일 차이를 확인한다. 이번 두 커밋에는 의존성·unit 변경이 없다. 기존 환경이 잠금파일과 일치하면 운영 의존성 재설치·daemon-reload는 필요 없다. 불일치가 확인되면 원인을 보고하고 기존 venv를 복구 가능하게 보존한 뒤 해당 잠금파일로만 설치한다. 자동 `audit fix`, 모델 변경, 호출 한도 증액을 하지 않는다.
6. 진행 중 분석이 정리되고 검사가 통과하면 API → AI 순서로 정상 중지한다. clean 운영 checkout에서 `git merge --ff-only <최종 전체 SHA>`를 실행한다. AI → API 순서로 기동한다. 기존에 활성 상태였던 평가 worker만, live 대기 작업을 임의 소비하지 않는 조건에서 새 코드로 원상 기동한다. 변경된 서비스는 `atlas-ai.service`, `atlas-api.service`, `atlas-eval-worker.service`다.
7. 새 환경변수·새 키·새 공개 포트는 없다. Node는 기존 `KIWOOM_APP_KEY`/`KIWOOM_SECRET_KEY` (기존 소문자 별칭 포함), `SUPABASE_URL`/`SUPABASE_SECRET_KEY`, `OpenDart_api_key`를 재사용한다. DART 키는 기존 수집 경로만 사용하고 AI 도구는 저장 자료만 읽는다. 키움 알림 전용 키를 대신 쓰거나 회원 개인 키를 공용으로 사용하지 않는다. AI는 기존 `OPENAI_MODEL`·`OPENAI_API_KEY`·`AI_INTERNAL_SECRET`·`AI_CALLBACK_URL`과 전체 예산을 유지한다. Node 키를 AI/eval 환경으로 복사하지 않는다. API와 AI의 내부 인증 일치 및 callback 포트/경로만 비밀값 없이 확인한다.
8. `deploy/ai_check.py --ai-env /etc/atlas/ai.env`를 승인된 권한으로 실행해 인증 health 200, `architecture=atlas-langgraph-research-v1`, registered_agents에 news/technical/market/fundamental/alert가 있는지 확인한다. 기존 모델·lab/alert 준비 상태 유지, loopback 리스닝, 비인증 AI health/run 401을 확인한다. API loopback·외부 health 200, 비인증 관리자 평가 401/403을 확인한다. `/api/internal/agent/data`는 무인증 401, 내부 인증이 있어도 임의/종료된 request_id는 409다. 정상 요청 경계·예산은 격리 HTTP 통합 검사로 확인한다. Vercel의 `/api/internal/agent/data`는 404이고 내부 경로를 새 프록시에 추가하지 않는다.
9. 실제 Node unit과 같은 사용자·작업 경로·환경파일로 `deploy/agent_research_smoke.js`를 실행한다. 환경을 shell로 source하거나 키를 argv/출력에 넣지 않는다. 예를 들어 실제 Node 경로가 `/usr/bin/node`이고 User가 atlas인 경우 아래처럼 transient unit에서 실행할 수 있다.

   ```sh
   sudo systemd-run --wait --pipe --collect --property=User=atlas --property=WorkingDirectory=/opt/atlas --property=EnvironmentFile=/etc/atlas/atlas.env /usr/bin/node /opt/atlas/deploy/agent_research_smoke.js market 005930
   sudo systemd-run --wait --pipe --collect --property=User=atlas --property=WorkingDirectory=/opt/atlas --property=EnvironmentFile=/etc/atlas/atlas.env /usr/bin/node /opt/atlas/deploy/agent_research_smoke.js market 035420
   sudo systemd-run --wait --pipe --collect --property=User=atlas --property=WorkingDirectory=/opt/atlas --property=EnvironmentFile=/etc/atlas/atlas.env /usr/bin/node /opt/atlas/deploy/agent_research_smoke.js fundamental 005930
   ```

   시세는 일치 종목 코드·정상 가격 계약·거래량·분봉/틱 범위·partial/지연 미확인 표시를 확인한다. 거래일/장외에는 오늘 봉 없음이 가능하므로 빈 결과를 장중 수신 성공으로 보고하지 않는다. ka10001 시각/실시간성은 정상 응답에도 확인 불가다. DART는 매핑·저장/조회 시각·범위·원문·정확한 문자열 금액과 stale/empty를 구분한다. 기본 공시 범위는 오늘-30일~오늘이며 이미 수집된 다른 범위는 CLI의 추가 시작/종료 인수로 지정한다. 미수집이면 실패가 아닌 준비 제한으로 보고하고, 기존 기업 분석 UI/API의 제한된 읽기 조회로 필요한 범위를 수집한 후 재검사할 수 있다. 새 수집기·타이머·DB를 만들지 않는다. CLI는 DART 수집을 시작하지 않으며 실제 OpenAI·주문·알림·메시지를 호출하지 않는다. 원문·키·토큰·환경 본문은 출력하지 않는다.
10. 관리자 도구 목록은 17개, 전체 담당은 총괄+5개다. 운영 health 등록·설정 준비·최근 정상 수신/DB 조회를 구분한다. 과거 운영 확인 SHA/시각 유지, 기존 대화·평가·승인 카드, 신규 고정 사례의 반복 등록 방지, 라이트·다크·모바일을 읽기 전용으로 확인한다. 실제 모델 담당 선택 품질은 별도 미검증으로 보고한다. 유료 평가·회원 관심종목 승인·알림 저장/취소·카카오 발송을 실행하지 않는다.
11. 평가 worker의 SHA·architecture·역할/도구 hash·고정 데이터 fingerprint 호환을 확인한다. 실제 평가 enqueue는 하지 않는다. 기존 DART 타이머·실험실 수집/WAL guard·알림 worker·DB/WAL/SHM·환경파일은 불필요하게 재시작·재설치·변경하지 않는다.
12. Vercel Production의 최종 SHA·배포 ID·success·운영 도메인을 확인한다. 새 프런트+이전 서버에서도 새 담당을 준비 미확인으로 표시한다. API/VPS 반영과 프런트 배포를 각각 보고한다.
13. 이상 시 새 분석/평가 실행을 멈추고 시작된 요청을 안전하게 종료/unknown 정산한다. 유료 호출을 재생하지 않는다. 이전 SHA로 clean checkout을 복구하고, 의존성을 바꿨다면 보존 venv/이전 lock도 복원한 뒤 AI → API → 원래 활성 평가 worker 순서로 기동한다. DB 스키마 변경이 없으므로 DB 롤백·이력 삭제 SQL은 실행하지 않는다. 필요하면 직전 정상 Vercel Production도 별도로 복구한다. 이전/현재 SHA, 검사·smoke 결과와 미검증 범위를 비밀값 없이 보고한다.
