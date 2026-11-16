# NH 자동매매 V2 계약 확인 결과

2026-11-16 공개 공식 자료를 확인했습니다. 실제 개인 API·주문·취소는 호출하지 않았습니다.

## 확인된 계약

- `cashBuy` / `cashSell` 응답 `Output_0.mkt_orr_no`는 정정·취소에 사용하는 시장주문번호입니다. `cancel.Input_0.org_mkt_orr_no`에는 이 접수 시장번호를 사용합니다. `itg_orr_no`로 대체하지 않습니다.
- KRX 지정은 현금 주문의 `rmt_mkt_cd=KRX`, `sor_mkt_sli_yn=N`입니다. 시장가 유형은 `05`, 보통 지정가는 `01`, 공매도 구분은 `00`입니다.
- 접수 응답의 KRX 자시장번호 `anw_cld_mkt_orr_no1`과 취소 응답의 새 시장번호/자시장번호는 별개의 값으로 보존해야 합니다. 취소 접수는 실제 잔량 취소 확인과 다릅니다.
- `/n2/acctinfo`의 본인 계좌를 먼저 선택합니다. 운영은 `acct_type=01/02`, 모의는 `03`입니다. 브라우저에는 계좌번호 대신 현재 사용자의 자격증명에 묶인 opaque ref를 반환합니다.
- 매수가능 조회의 `csh_orr_pbl_amt` / `csh_orr_pbl_qty`가 미수 없는 현금 기준입니다. 최대 가능 금액/수량은 미수 포함 가능성이 있으므로 대체하지 않습니다.
- `currentExecution`의 KRX 정규장 조회에서 종목과 실제 `bsop_hour`를 확인합니다. 시각은 검증된 현재 세션 날짜와 결합하며 수신 시각으로 대체하지 않습니다.

## 아직 확인할 수 없는 필수 복구 계약

1. **시장주문번호 ↔ 통합주문번호 연결**
   - 접수 응답: `mkt_orr_no`, 자시장번호.
   - `dailyOrderExecution` 요청/응답: `itg_orr_no`, `org_itg_orr_no`.
   - 해당 REST 응답에는 시장주문번호가 없고, 두 번호의 동등성/변환 규칙도 명시되지 않았습니다. KRX 단일 시장이라는 이유로 같은 번호라고 가정하지 않습니다.
2. **재시작 후 실제 체결 시각과 개별 체결 복원**
   - REST 응답에는 누적 체결수량·평균가·금액·건수는 있지만 개별 체결 ID와 체결 시각이 없습니다.
   - WebSocket `d2`에는 `orderno/concgty/concprc/conctime`, `d3`에는 `orderno/orgordno/order_time`이 있으나 REST 번호와의 연결 및 재접속 시 재생/누락 복구 계약은 공개 명세에 없습니다.
   - 현재 시각·마지막 시세 시각을 주문 체결 시각으로 만들어 넣을 수 없습니다. 같은 초·가격·수량의 통보를 유일 체결 ID로 임의 간주하지 않습니다.

이 때문에 `createTradingNhGateway`는 `readSupported=true`, `supported=false`, `nh_recovery_contract_unverified`로 반환합니다. 조회·계좌 선택·개인 차트와 번호 정규화는 구현했지만, 새 주문과 취소는 HTTP 전송 없이 차단합니다. 이것을 NH 자동매매 지원 완료로 보고하면 안 됩니다.

## 확인한 공식 자료

- 국내주식 전체 REST/실시간 명세: https://www.nhplug.com/openapi-docs/krstock/openapi.json
- 공통 계좌·종합거래내역 명세: https://www.nhplug.com/openapi-docs/common/openapi.json
- 통합 설명: https://www.nhplug.com/llms-full.txt
- 공식 SDK·샘플: https://github.com/PLUG-OpenAPI/nhplug-sdk

국내주식 공개 REST 경로에는 `dailyOrderExecution` 외에 주문 번호 매핑·개별 체결 상세 조회가 없었습니다. 공통 `totalTransaction`에도 해당 주문 ID/체결 시각이 없습니다. 공식 SDK 공개 샘플에는 현금 매수·매도와 시세/실시간 체결 예제가 있지만 번호 연결·재시작 복구를 해결하는 예제는 확인하지 못했습니다.

## 활성화를 위해 필요한 확인

NH의 공식 추가 답변/명세 또는 비식별 공식 응답 샘플로 번호 연결 규칙이나 조회 경로를 확인해야 합니다. 실제 체결 시각·체결 식별자의 재접속/복구 경로도 필요합니다. 제공받은 계약을 고정 fixture로 추가하고 기존 과거 주문의 읽기 전용 대조로 확인할 수 있습니다. 운영 검증을 이유로 새 주문·취소를 임의 실행하거나 계좌번호·토큰·주문 원문을 채팅에 보내면 안 됩니다.
