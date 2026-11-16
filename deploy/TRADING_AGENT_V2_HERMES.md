# 자동매매 V2 운영 반영

대상은 이 문서를 포함하는 `자동매매 v2` 커밋입니다. 최종 전달문의 전체 SHA를 사용합니다. 이 절차는 배포이며 실거래 활성화가 아닙니다.

## 계약과 제한

- 키움: 기존 KRX 현금 주문·개별 체결 대조를 유지합니다. 기존 정책 없는 V1 키움 스냅샷만 KRX 정책으로 해석합니다.
- 토스: 공식 OpenAPI `https://openapi.tossinvest.com/openapi-docs/latest/openapi.json`의 기본 SOR 주문을 사용합니다. KRX 지정 파라미터는 보내지 않습니다. 시세와 차트는 거래소를 제공하지 않는 공급자 기준이며 실행 스냅샷·확인창에 별도로 표시합니다. 검증된 KRX 정규장 **시간** 안에서만 주문합니다.
- 토스 현금 매수 한도는 `cashBuyingPower`, 수량 상한은 현금/가격의 보수적 계산입니다. 증권사가 반환한 매수가능수량이라고 표시하지 않습니다. 별도 정확한 사전 수량 API는 확인되지 않았습니다.
- 토스 주문번호와 취소 작업의 새 번호를 별도로 보존합니다. 누적 체결 수량·금액 및 마지막 실제 체결시각으로 복구합니다. REST가 제공하지 않는 개별 체결 ID/시각을 만들지 않습니다. 주문 접수 응답 전체가 유실되어 번호를 모르면 불명 상태로 정지하며 재전송하거나 유사 주문을 추정 매칭하지 않습니다.
- 토스 공식 `status=OPEN`은 모든 대기 주문을 한 번에 반환하고 cursor/limit를 무시합니다(`hasNext=false`, `nextCursor=null`). 이 계약에 어긋나면 전체 조회라고 가정하지 않고 차단합니다. 접수 후 복구는 정확한 orderId 상세 조회를 사용하므로 CLOSED 목록의 100건 cursor 페이지를 추정 검색하지 않습니다.
- NH: 본인 계좌·현금 한도·보유·시세·개인 차트·주문번호 정규화는 구현했습니다. 그러나 접수 시장번호↔통합번호 연결과 재시작 후 실제 체결 복원 계약이 없어 **조회 지원/자동 주문·취소 차단**입니다. `TRADING_NH_V2_CONTRACT.md` 참고. 사용자가 추가 자료 없음과 실행 제한을 선택했습니다.
- KB는 기존 지원 제한을 유지합니다. 다른 회원·운영자·다른 증권사로 대체하지 않습니다.
- 이번 검증은 공식 문서+모의 HTTP+격리 DB+격리 브라우저입니다. 실계좌 수신/모의투자 서버/실주문 검증 완료를 뜻하지 않습니다.

## 사전 확인과 안전한 전환

1. `/opt/atlas`의 실행 사용자 `atlas`, clean detached 상태, OLD SHA, main 조상 관계, unit·환경·직전 Vercel Production SHA를 비밀값 없이 기록합니다. `/etc/atlas/atlas.env` 및 `/etc/atlas/trading.env`는 승인된 root 전용 경로에 안전하게 백업합니다.
2. 인증된 서비스 전용 trading RPC의 `context`는 회원 소유 조회이며 전역 현황이 아닙니다. 아래 SQL Editor 집계를 DB 담당자에게 받아 전체 실행·보유·미체결·전송불명을 확인합니다. 회원 ID·계좌·주문 원문은 출력하지 않습니다.

```sql
select count(*) filter(where status not in ('stopped','completed')) active_sessions,
 count(*) filter(where coalesce((state->'position'->>'quantity')::numeric,0)>0) nonzero_positions
from public.trading_v1_sessions;
select count(*) filter(where status in ('prepared','sending','accepted','partial','unknown')) open_intents,
 count(*) filter(where status in ('sending','unknown')) uncertain_intents
from public.trading_v1_intents;
select count(*) configs,(select count(*) from public.trading_v1_sessions) sessions,
 (select count(*) from public.trading_v1_intents) intents,
 (select count(*) from public.trading_v1_fills) fills from public.trading_v1_configs;
```

3. 실행·보유·미체결·불명이 하나라도 있으면 바로 worker를 끄거나 구버전으로 돌아가지 않습니다. 신규 진입 중단, 본인 소유 주문/체결/보유 읽기 대조, 보호 관리 담당자 인계 및 짧은 전환 창을 먼저 확보합니다. 정지 요청은 보호 관리를 유지하며 강제 청산이 아닙니다. 관리 중단은 별도 명시적 승인 사항입니다. 승인 없는 주문·취소·강제 청산·불명 재전송은 하지 않습니다. 안전한 전환 창을 확보할 수 없으면 현재 보호 실행을 유지하고 전환을 보류합니다.
4. 실행 상태가 모두 0이고 worker가 원래 disabled/inactive이면 그대로 유지합니다. 실행 중인 worker가 있다면 위 인계 완료 후 정상 종료를 기다려 진행 중 tick/HTTP가 끝났음을 확인합니다. API도 정상 종료한 뒤 SQL/코드를 전환합니다. 구형·신형 worker/API를 동시에 실행하지 않습니다.

## SQL → 서버 → 프런트 순서

1. 복구 가능한 DB 백업 확보 후 대상 커밋의 **`deploy/TRADING_AGENT_V2_SUPABASE.sql` 전체만** 적용합니다. V1·계정·전략·알림 SQL을 재실행하지 않습니다. 기존 기록은 삭제하지 않습니다.
2. 마지막 postcheck: marker `atlas-trading-v2`, RPC 권한 `false,false,true`, base RPC `false,false,false`, 7개 테이블 RLS=true/직접 접근=false, epoch 권한 `false,false,true,false,false,false`, 누락 epoch=0. 사전/사후 설정·실행·intent·fill 건수를 비교합니다.
3. SQL은 `account_label`, `strategy_snapshot`, 비공개 `trading_broker_versions`를 추가합니다. 초기 epoch는 기존 settings_version과 같아 기존 키움 실행 해시를 보존합니다. 이후 해당 증권사 삭제/재등록만 epoch를 변경합니다. 기존 CAS·암호화 경로는 유지합니다. **새 서버는 이 컬럼을 읽으므로 SQL이 반드시 먼저입니다.** V2 wrapper는 기존 키움 V1 호출·스냅샷을 수용하나 구형 코드로 토스 실행을 관리할 수는 없습니다.
4. 격리 worktree에서 기존 lockfile로 `npm ci`, `npm run test:server`, `node --test tests/trading*.test.js`, `npm run build`를 실행합니다. 네이티브 PostgreSQL 선택 검사는 별도 비운영 DB만 사용합니다. 운영 DB를 테스트 fixture로 사용하지 않습니다.
5. 환경에 **`ATLAS_TRADING_TOSS_ENABLED=false`**를 추가합니다. 미설정도 false입니다. 기존 WORKER/LIVE/KIWOOM/TOSS/NH 주문 플래그를 임의 활성화하지 않습니다. V1 최초 배포 상태라면 WORKER=false/LIVE=false, worker disabled/inactive를 그대로 유지합니다. 운영 중인 보호 실행이 있다면 플래그를 일괄 false로 바꿔 보호를 끊지 말고 사전 인계 절차를 따릅니다. 새 비밀값·의존성·unit 변경은 없습니다.
6. `atlas`로 `git fetch origin main`, 대상 SHA가 origin/main에 포함됨과 OLD의 후속임을 확인하고 clean checkout에서 `git merge --ff-only TARGET`합니다. `atlas-api.service`만 기동합니다. V1 unit은 변경하지 않으며 daemon-reload가 필요 없습니다. 승인된 기존 worker가 있었다면 API readiness 뒤 원래 상태로 복원합니다. 원래 inactive이면 시작하지 않습니다.
7. API 재시작 후 준비 신호가 초기화됩니다. UI의 workerReady는 인증된 loopback tick의 최근 성공으로만 확인됩니다. 활성화 플래그만으로 준비 완료로 표시하지 않습니다. 비활성 worker 상태에서 시작 버튼 비활성은 정상입니다. 검증을 위해 worker를 켜거나 승인된 tick을 호출하지 않습니다.
8. 프런트는 main의 Vercel 자동 배포입니다. GitHub push만으로 운영 반영 완료라고 보고하지 않습니다. 새 프런트가 먼저 배포되면 V1 서버에서도 키움 기존 기능은 유지되지만 토스 신규 시작은 V2 marker 없으면 차단됩니다. SQL/API 전환 후 Vercel Production SHA·배포 ID·안정 도메인을 확인합니다.

## 주문 없는 운영 확인

- loopback/기존 외부 `/api/health` 200.
- 비인증 GET `/api/agent/trading`, `/connections`, `/session?sessionId=<검사용 UUID>`, `/chart` 및 POST `/config`, `/preview`, `/start`, `/stop`는 401. 인증 없는 임의 출처는 403 또는401이며 허용되지 않아야 합니다.
- 비인증/외부 Origin 있는 internal tick은 401, Vercel internal 경로는 404. 실제 내부 비밀로 tick을 실행하지 않습니다.
- 허용된 회원의 읽기 전용 UI: 설정·실행·진행상황, 실행 화면에 차트 없음, 저장 버전/계좌 구분, NH 복구 계약 제한, Toss SOR/공급자 시세 표시, 미선택 진행상황, 기존 이력·평균선 표시. 설정 저장/삭제/시작/정지 버튼을 운영 검증 목적으로 누르지 않습니다. 데이터가 없으면 fixture 검증과 운영 미검증을 구분합니다.
- API·원래의 trading worker만 상태 확인하고 로그는 오류 개수·안전한 코드만 확인합니다. 토큰·Authorization·계좌·주문/응답 본문·환경파일을 출력하지 않습니다.
- AI·평가·알림 worker·DART·일봉 수집/검증/발행·WAL guard 및 일봉 DB는 재시작·변경하지 않습니다.

## 이상 시 복구

활성 실행·포지션·미체결·불명이 모두 0이면 API 정상 중지 → OLD clean detached checkout → API 기동, 필요 시 직전 Vercel Production 재승격합니다. 원래 worker 상태/플래그를 복원하고 health/401을 확인합니다. V2 SQL/epoch/실행/주문번호 매핑은 그대로 보존하며 DROP/DELETE·역방향 SQL·epoch 초기화를 하지 않습니다.

하나라도 남아 있으면 단순 worker 중지/구형 코드 복귀를 하지 않습니다. 신규 진입 차단 → 소유 주문·보유·불명 상태 읽기 대조 → 담당자 보호 관리 인계 → 명시적 관리 중단 승인 후 코드 복귀 여부 판단 순서입니다. 특히 구형 키움 전용 코드가 토스 실행을 이어 관리한다고 가정하지 않습니다. 불명 주문 재전송·강제 시장가 청산은 금지합니다.
