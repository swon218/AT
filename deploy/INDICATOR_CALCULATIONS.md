# 보조지표 계산 규격

기간은 해당 주기의 봉 개수다. 준비 구간은 `null`, 조건 판정은 반올림 전 수치로 처리한다. 같은 입력과 설정을 JS 차트와 Python 계산 엔진에 공급하면 계산 규격이 같다. 기존 SMA·EMA, 볼린저밴드, 거래량 이동평균, RSI, MACD 규격은 유지한다.

| 지표 | 기본 설정 | 첫 유효 값과 경계 |
| --- | --- | --- |
| ATR·ATR% | Wilder 14, ATR 표시 | 구간 첫 봉 TR은 고가−저가. N개 TR의 평균으로 RMA를 초기화하고 이후 `이전값 + (TR−이전값)/N`. ATR%는 ATR을 같은 봉의 종가로 나눈 퍼센트. |
| DMI·ADX | DI 14, ADX 14, 기준 20·25 | 첫 봉은 이전 고저가가 없어 TR·DM 평활에 넣지 않는다. 움직임 동률은 +DM·−DM 모두 0. DI는 N+1봉, ADX는 N+M봉부터 계산 가능. 평활 TR이 0이면 DI=0, DI 합이 0이면 DX=0. ADX는 방향이 아닌 강도. |
| 스토캐스틱 | 14/3/3, 기준 20·80 | 최근 N봉 고저 폭에서 RawK 계산 후 SMA로 K와 D 계산. 각각 N+K−1, N+K+D−2봉부터 가능. 고저 폭 0이면 RawK는 `null`이고 연속 평활을 다시 준비한다. |
| OBV·평균 | 구간 첫 값 0, SMA 20, 평균선 숨김 | 종가 상승·하락이면 거래량을 더하거나 빼고, 동일 종가이면 유지. 평균은 SMA 또는 최초 N개 평균으로 시작하는 EMA. 누적 시작점은 제공된 계산 이력의 첫 유효 봉이며 누락 뒤에는 새 구간을 0으로 시작한다. |
| MFI | 14, 기준 20·80 | HLC3의 변화로 방향을 분류해 HLC3 × 거래량을 합산. N+1봉부터 계산 가능. 양의 흐름만 있으면 100, 음의 흐름만 있으면 0, 두 합이 모두 0이면 `null`. 같은 대표가격의 흐름은 0. |
| CCI | 20, HLC3, 기준 −100·0·100 | N봉부터 가능. 그 구간의 동일한 평균에 대한 평균절대편차를 사용. 평균절대편차 0이면 `null`. 축 범위는 고정하지 않는다. |
| 슈퍼트렌드 | ATR 10 × 3, 전환 표시 | ATR 준비 전 가격·방향·전환은 `null`. 첫 ATR 유효 봉은 하락 방향으로 초기화하며 전환은 0. 밴드는 이전 최종 밴드와 이전 종가로 갱신한다. 종가가 해당 밴드를 엄격히 넘어야 전환되며 동일 가격에서는 기존 방향을 유지한다. 방향 `1/-1`, 전환 `1/-1/0`. |

규격은 TradingView의 [ATR](https://www.tradingview.com/support/solutions/43000501823-average-true-range-atr/), [DMI](https://www.tradingview.com/support/solutions/43000502250-directional-movement-dmi/), [스토캐스틱](https://www.tradingview.com/support/solutions/43000502332-stochastic-stoch/), [OBV](https://www.tradingview.com/support/solutions/43000502593-on-balance-volume-obv/), [MFI](https://www.tradingview.com/support/solutions/43000502348-money-flow-mfi/), [CCI](https://www.tradingview.com/support/solutions/43000502001-commodity-channel-index-cci/), [슈퍼트렌드](https://www.tradingview.com/support/solutions/43000634738-supertrend/)를 기준으로 대조했다. `ta.tr(true)`와 같이 이전 종가가 없을 때 첫 진폭을 고저 차이로 계산한다. 누락 시 재준비, 무흐름 MFI와 폭 0인 스토캐스틱·CCI의 `null`, OBV 0 기준, 슈퍼트렌드의 방향 부호와 동률 처리는 ATLAS의 명시적 정책이다. TradingView와 비교할 때 설정, 이력 시작점, 가격 소스와 봉을 일치시킨다. [Pine 내장 함수](https://www.tradingview.com/pine-script-docs/language/built-ins/)

- 주식주문은 선택한 증권사가 제공한 OHLCV와 주기를 사용한다. 조회 범위는 기존 계약대로 최대 200봉이며 응답이나 상장 이력이 짧으면 긴 지표가 준비되지 않을 수 있다. 진행 중인 봉의 지표는 변한다. 확대·스크롤·보이는 범위를 바꿔도 전체 제공 이력으로 계산한다. 추가 이력이 포함된 새 스냅샷은 같은 규칙으로 다시 계산하며, 실제 첫 봉이 달라지면 OBV 절대값의 기준도 달라진다.
- 실험실과 AI는 기존 수집·품질 정책에 따라 수정주가 기준으로 저장된 OHLC 및 제공처가 보고한 거래량을 사용한다. 거래량에 별도의 조정 배수를 적용하지 않는다. 차트에서는 격리된 봉과 누락 값을 빈 구간으로 두고 준비를 다시 시작한다. 새 지표를 쓰는 AI 검색에서는 가격이 정상인 거래량 0을 그대로 사용하며, 날짜 누락·격리·가격 및 거래량 오류는 해당 종목의 제외 사유로 돌려준다. AI는 최대 2,000개 저장 봉에서 최신 확정 일봉까지 계산한다. 다른 데이터 출처나 이력 시작점을 가진 차트와 수치가 다를 수 있다.
- MFI와 OBV는 투자자별 수급·입출금 자료가 아니다. 서로 다른 종목의 OBV 절대값은 공통 척도가 아니다. 스토캐스틱·MFI 참고 범위는 반전을 보장하지 않는다. 일곱 지표의 조건 판정은 조건검색·연구에만 쓰며, 실험실 모의매매는 기존에 제공하는 규칙만 선택할 수 있다.

`tests/advancedIndicators.fixture.json`은 손으로 검산할 수 있는 6봉과 기댓값이다. 예를 들어 첫 두 TR은 2와 4이므로 ATR(2)의 첫 값은 3이다. 세 번째 봉의 MFI는 `100×91/(91+136/3)`이다. 두 언어에서 초기화·결측 패턴과 수치를 비교한다. 선택적으로 TA-Lib를 설치한 격리 환경에서는 별도 100봉으로 ATR, K/D, OBV, MFI, CCI를 독립 대조한다. TA-Lib의 첫 ATR에는 가상 이전 종가를 넣고 OBV는 첫 거래량을 빼서 초기 기준을 맞춘다. ADX와 슈퍼트렌드는 공통 수작업 케이스로 대조한다. [TA-Lib 함수 문서](https://github.com/TA-Lib/ta-lib-python/blob/master/docs/funcs.md)
