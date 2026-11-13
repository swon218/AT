# 증권사 API 키 생명주기 배포

TARGET은 최종 전달받은 전체 SHA를 사용한다. 기본 원격은 origin/main, 운영 경로는 /opt/atlas다.
환경변수·암호화 키·의존성·lockfile·systemd unit 변경은 없다. SQL은 운영 DB에 자동 적용하지 않았다.

## 배포 전

- 현재 운영 SHA(OLD), clean 여부와 기존 복구 기준을 기록한다. 비밀값/행 원문을 출력하지 않는다.
- fetch 후 TARGET이 main에 포함되고 OLD의 후속인지, 다른 미반영 서버 기능이 섞이지 않았는지 확인한다.
- 키 암호문은 유지된다. 마이그레이션은 설정 버전 컬럼과 CAS RPC, 권한만 변경한다.
- 기존 백업/복구 지점의 실제 확보 여부를 기록한다. 백업 생성 실패를 성공으로 보고하지 않는다.
- 격리 worktree에서 `npm run test:server`,
  `node --test tests/integrationSettings.test.js tests/accountSettingsApi.test.js tests/brokerCredentialDb.test.js tests/credentialLifecycleIntegration.test.js tests/brokerConnections.test.js tests/theme.test.js`,
  `npm run build`를 실행한다. 운영 의존성은 재설치하지 않는다.

## 순서

1. DB 담당자가 TARGET의 `BROKER_CREDENTIAL_LIFECYCLE_SUPABASE.sql` 전체를 인증용 Supabase SQL Editor에서 실행한다.
   기존 암호문·텔레그램·다른 테이블을 삭제하지 않는다. 과거 BROKERS SQL을 다시 실행하지 않는다.
2. 마지막 권한 확인은 `false,false,true,false,false,false,true`, RLS=true, null_versions=0이어야 한다.
   SQL 내부 권한 가드 실패 시 전체 트랜잭션을 롤백한다. 권한을 무작정 열어 우회하지 않는다.
3. SQL 커밋부터 새 API 기동까지 구형 개인설정 직접 쓰기는 실패하며 읽기·기존 자격증명은 유지된다.
   새 프런트도 구형 API 응답에는 키 변경을 잠근다. 설정 쓰기 불가 구간을 명확히 안내한다.
4. 진행 중 API 요청이 끝난 뒤 atlas-api만 정상 중지한다. `git merge --ff-only "$TARGET"` 후 API만 기동한다.
   VPS에 프런트 빌드는 필요 없다. 새 코드가 SQL보다 먼저 기동되어도 저장 상태 오류로 쓰기를 거절한다.
5. Vercel Production SHA가 TARGET인지와 운영 도메인의 새 UI를 확인한다. 푸시 성공과 API/DB 반영을 구분한다.

## 운영 읽기 확인

- loopback·기존 외부 health 200, API active, 새 fatal/5xx 없음.
- 비로그인 GET/PUT /api/account/settings 및 DELETE /api/account/settings/kiwoom은 401.
- 허용된 회원 세션이 있으면 저장 메타데이터·버전·잠금·삭제 버튼을 읽기만 확인한다.
  원문 키·토큰·암호문·계좌번호를 출력하거나 세션 토큰을 추출하지 않는다.
- 운영 회원 키를 저장/삭제/교체해 배포를 검증하지 않는다. 덮어쓰기/동시성/삭제 검증은 격리 테스트로만 한다.
- 삭제는 ATLAS 저장 정보만 제거한다. 증권사 키 폐기·기존 주문 취소가 아니다.
- 알림/평가/AI, DART·일봉 수집·WAL 서비스와 DB를 중단·재시작·수리하지 않는다.
- 실제 주문·정정·취소, 카카오 발송, 유료 AI 호출을 하지 않는다.

## 복구

API 이상 시 API만 중지하고 `git switch --detach "$OLD"` 후 API만 기동하여 health와 인증 차단을 확인한다.
SQL의 컬럼·버전·RPC·데이터는 그대로 둔다. 구형 코드의 쓰기는 계속 차단된다.
개인설정 쓰기는 새 버전 복구 전까지 일시 불가로 안내하고 전진 복구를 우선한다.
구형 API를 살리기 위해 service_role 직접 쓰기/GRANT ALL/기존 BROKERS SQL을 복원하지 않는다.
필요하면 직전 정상 Vercel Production을 재승격한다. 강제 reset/push, DB/암호문 삭제·복원은 하지 않는다.
최종 DB 적용 여부·권한 결과, VPS SHA·서비스, 프런트 SHA 및 미검증 범위를 각각 보고한다.
