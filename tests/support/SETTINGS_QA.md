# 증권사 키 잠금·삭제 모의 검증

실행: `npx vite --config tests/support/vite.settings.config.js`
주소: `http://127.0.0.1:5184/tests/support/settings.html`

제품의 AccountSettingsModal/KakaoConnectionSection/SidebarFooter와 실제 프런트 요청 서비스를 사용한다.
프로필·세션·API는 로컬 메모리 모의 서버로 격리한다. env 미로드, 실제 API·주문·메시지 경로 차단.
설정 조회는 설정 버전과 저장 불리언만 반환한다. 요청 기록에는 키 값이 아닌 필드명·메서드·성공 여부만 있다.

검증 도구는 실패/정상/구형 응답, 응답 유실 후 삭제 여부, 느린 삭제, 다른 기기 재등록을 모의한다.
인증 조회 지연 버튼을 누른 뒤 모달을 닫고 열면 최초 조회 중 전체 입력 잠금을 확인할 수 있다.
두 탭을 열어 한쪽에서 삭제·재등록하면 다른 쪽 확인창 종료와 잠금 동기화를 확인한다.

2026-11-14 Chrome 검증:

- 미저장 입력 → 실패 시 입력·미저장 유지 → 잘못된 모의 키 저장 성공 시 빈 input 잠금.
- 새로고침 후 저장 상태 복원, 저장된 실제 원문을 value로 넣지 않음.
- 취소·Escape·확인창 닫기는 미전송. 확인 후 별도 DELETE, 성공 시 해당 입력만 해제.
- 다른 증권사의 미저장 초안 보존. 삭제 실패 잠금 유지, 응답 유실 시 GET 재확인.
- 오래된 확인 버전 삭제는 충돌 후 재조회. 임의 자동 재전송 없음.
- 두 실제 Chrome 탭에서 삭제·재등록 동기화와 오래된 확인창 취소.
- 느린 삭제 확인 더블클릭 시 DELETE 1회, 전송 중 취소·Escape 차단.
- 조회 실패·재시도, 구버전 API 응답 시 쓰기 전체 잠금, 초기 2초 조회 중 잠금.
- 키움/토스/NH/KB 순서, 카카오·기존 ! 도움말/IP 유지, 텔레그램 UI 없음.
- 기본 1229×944 및 390×844, 320×568; 라이트·다크, 확인창·도움말 경계와 가로 넘침 없음.
- 물리적 터치 기기와 운영 회원 저장/삭제/재로그인은 미검증.

서버 테스트는 실제 AES와 CAS 모의 저장소를 사용한다. `brokerCredentialDb.test.js`는 실제 PGlite SQL의
권한·RLS·CAS·반복 적용을, `credentialLifecycleIntegration.test.js`는 제품 Node 핸들러→AES→실제 SQL RPC를 검증한다.
PGlite 단일 엔진이므로 물리적 다중 PostgreSQL 세션의 잠금 대기는 미검증이다.
운영 SQL 적용과 VPS 반영은 별도이며 `deploy/BROKER_CREDENTIAL_LIFECYCLE_HERMES.md`를 따른다.
