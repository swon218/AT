# 실험실 백테스트 v2 반영

이번 계산은 브라우저의 공개 일봉 모의 계산이다. 실제 주문·자동매매 worker·시세 수집 API·일봉 DB·AI·카카오 발송은 변경하지 않는다.

## 적용 순서와 호환성

1. DB 담당자가 현재 `public.strategies`의 복구 가능한 기준을 확보한다. 키나 회원별 행을 채팅·로그에 출력하지 않는다.
2. 인증용 Supabase SQL Editor에서 이번 커밋의 `deploy/BACKTEST_STRATEGIES_V2_SUPABASE.sql` 전문을 적용하고 마지막 두 확인 쿼리를 확인한다. 기대값은 `rls=true, invalid_v2=0, allowed_versions=true, revision_trigger=true` 및 `guest_read=false, member_read=true, member_revision_write=false, validator_member=true`이다.
3. 같은 커밋의 Vercel Production 배포를 확인한다. 권장 순서는 SQL → 프런트이다. main 자동 배포가 먼저 완료된 경우 SQL 적용 전의 v2 저장은 기존 DB 제약으로 거절되며, 화면에서 SQL 준비 안내를 표시한다. 기존 v1 조회와 로컬 모의 계산은 사용할 수 있다.
4. 허용된 테스트 계정에서만 새 부분 전략 저장·불러오기를 확인한다. 실제 회원의 기존 전략을 배포 검증 목적으로 수정하거나 삭제하지 않는다. 운영 DB의 변경 검증이 승인되지 않았으면 미검증으로 기록한다.

SQL은 새 테이블 없이 기존 JSON 정의와 스키마 버전을 확장한다. 기존 v1 행·revision을 자동 수정하지 않는다. 반복 적용도 기존 데이터를 보존한다. 소유권 RLS·수정 가능한 열·revision 트리거는 유지하고 새 v2 정의에만 엄격한 지표/조건/단위/익절·손절 검증을 적용한다. 브라우저에 service-role 키를 추가하지 않는다.

구버전 프런트는 SQL 적용 후에도 v1 쓰기가 가능하다. 다만 v2 전략을 불러오지 못할 수 있으므로 문제 발생 시 이전 정상 Vercel Production으로 복구하되 SQL·v2 데이터는 삭제하지 않는다. DB를 과거 형식으로 강제 축소하지 말고 후속 수정으로 해결한다.

## 설정과 계산

- 전략: 지표 설정, 지표별 진입 조건, AND/OR, 익절·손절. 종목·날짜·최초 수량·수량 방식은 각 탭의 실행 설정으로 분리한다.
- v1 전략은 읽을 때만 알려진 진입 규칙을 변환하고 옛 비용·초기자금·지표 청산 규칙을 별도 legacy 메타데이터로 보존한다. 익절·손절을 임의로 만들지 않는다.
- 확정 일봉의 신호는 다음 거래일 시가에 정수 수량으로 진입한다. 최초 실제 매수가×최초 수량을 기준금액으로 삼고 이후 추가 입금 없이 현금을 보존한다.
- 비용은 0이다. 익절·손절은 전량 청산, 갭은 시가, 양쪽 도달은 손절 우선 가정이다. 일봉으로 실제 체결 순서를 복원한 결과가 아니다.
- 확인된 거래일 달력이 없는 실제 일봉 응답은 날짜 공백의 휴장/누락 여부를 독립 검증하지 못한다. 결과에 실제 평가 일봉 날짜와 coverage 경고를 표시한다. 오래된 평일 자료로 종료일 평가가 끝났다고 표시하지 않는다.

## 검증

```powershell
npm run test:server
node --test server/backtest.test.js server/dataQuality.test.js tests/strategies.test.js tests/strategyDraft.test.js tests/advancedIndicators.test.js tests/backtestPresentation.test.js
npm run build
```

로컬 브라우저 검증: `npx vite --config tests/support/vite.backtest.config.js` 실행 후 `http://127.0.0.1:5185/tests/support/backtestV2.html`을 연다. 실제 컴포넌트·공통 훅, 메모리 전략 저장소, 종목 999999의 합성 일봉만 사용한다. 환경파일·운영 DB·회원 키를 사용하지 않고 다른 API는 차단한다. 운영 배포에 fixture를 사용하지 않는다.

## VPS

VPS 작업 없음. 서버 실행 코드·의존성·환경변수·unit 변경 없음. API·AI·알림·평가 worker 및 DART·일봉 수집·WAL 서비스를 재시작하거나 DB/WAL/SHM을 변경하지 않는다.
