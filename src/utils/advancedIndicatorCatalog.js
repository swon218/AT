const period = (key, label, value) => ({ key, label, value, min: 1, max: 500, step: 1 })
const number = (key, label, value, min, max, step = 1) => ({ key, label, value, min, max, step })
const choice = (key, label, value, options) => ({ key, label, value, options })
const color = (key, label, value) => ({ key, label, value, color: true })
const toggle = (key, label, value = true) => ({ key, label, value })
const help = (overview, inputs, reading, automation, caution) => ({ overview, inputs, reading, automation, caution })
const levels = () => [number('lower', '하단 기준', 20, 0, 100), number('upper', '상단 기준', 80, 0, 100)]

export const ADVANCED_INDICATORS = [
  {
    id: 'atr', name: 'ATR 평균진폭', shortName: 'ATR', pane: 'lower',
    fields: [period('period', '기간', 14), choice('display', '표시 단위', 'price', { price: 'ATR (원)', percent: 'ATR%' }), color('color', 'ATR 선 색상', '#d28b25')],
    help: help('장중 범위와 전일 종가 사이의 갭을 함께 반영한 변동성 지표입니다.',
      ['기간: 계산에 쓰는 봉 수입니다. 초기 평균 이후 Wilder RMA로 평활합니다.', '표시 단위: 원 단위 ATR 또는 종가로 나눈 ATR%. 색상은 표시용입니다.'],
      '하단 패널의 값이 커지면 한 봉의 가격 움직임이 커진 것입니다.', 'ATR%가 3% 이상인 종목을 변동성 조건으로 찾을 수 있습니다.',
      'ATR은 상승·하락 방향을 나타내지 않습니다. 봉 주기와 가격 기준을 맞춰 비교하세요.'),
  },
  {
    id: 'dmi', name: 'DMI · ADX 방향성지수', shortName: 'DMI · ADX', pane: 'lower',
    fields: [period('period', 'DI 기간', 14), period('adxPeriod', 'ADX 평활 기간', 14),
      toggle('showAdx', 'ADX 표시'), color('adxColor', 'ADX 색상', '#ae72df'),
      toggle('showPlus', '+DI 표시'), color('plusColor', '+DI 색상', '#db5661'),
      toggle('showMinus', '−DI 표시'), color('minusColor', '−DI 색상', '#4385e5'),
      toggle('showLevels', '기준선 표시'), number('lower', '기준 1', 20, 0, 100), number('upper', '기준 2', 25, 0, 100)],
    help: help('ADX는 추세 강도이며 +DI와 −DI는 위·아래 방향 움직임을 비교합니다.',
      ['DI 기간: 진폭과 방향 움직임을 평활하는 봉 수. ADX 평활 기간: DX를 다시 평활하는 봉 수.', '세 선의 색상과 표시 여부, 참고 기준선을 설정할 수 있습니다.'],
      'ADX가 높을수록 방향성 움직임이 강했고, +DI와 −DI 중 어느 쪽이 위인지 별도로 확인합니다.',
      'ADX ≥ 25와 +DI > −DI를 함께 조건으로 사용할 수 있습니다.', 'ADX 상승 자체로 가격 방향을 알 수 없으며 기준선은 참고값입니다.'),
  },
  {
    id: 'stochastic', name: '스토캐스틱', shortName: 'Stochastic', pane: 'lower',
    fields: [period('period', '고저가 조회 기간', 14), period('kPeriod', '%K 평활', 3), period('dPeriod', '%D 평활', 3),
      ...levels(), color('kColor', 'K 색상', '#4b86ff'), color('dColor', 'D 색상', '#d28b25')],
    help: help('최근 고저 범위에서 종가의 상대 위치를 0~100으로 표시합니다.',
      ['고저가 조회 기간과 K·D 평균의 봉 수를 설정합니다. K 평활 1은 원래 %K를 사용합니다.', '상·하단 기준과 K·D 색상은 표시를 조절합니다.'],
      'K와 D의 교차, 기준선 진입과 이탈을 확인합니다.', 'K가 D를 상향 교차한 확정 일봉을 찾을 수 있습니다.',
      '과열 구간이 즉시 반전을 뜻하지 않습니다. 고저 범위가 0이면 값이 없습니다.'),
  },
  {
    id: 'obv', name: 'OBV 누적거래량', shortName: 'OBV', pane: 'lower',
    fields: [color('color', 'OBV 색상', '#2ea986'), toggle('showAverage', '평균선 표시', false),
      choice('maType', '평균선 종류', 'SMA', { SMA: 'SMA', EMA: 'EMA' }), period('maPeriod', '평균선 기간', 20), color('maColor', '평균선 색상', '#ae72df')],
    help: help('종가가 오른 봉의 거래량은 더하고 내린 봉의 거래량은 빼는 누적값입니다.',
      ['표시 범위와 별개로 제공된 계산 이력의 첫 유효 봉을 0으로 시작합니다.', 'OBV 색상과 평균선의 표시, 종류, 봉 수, 색상을 설정합니다.'],
      '같은 종목에서 누적선의 방향과 평균선과의 관계를 확인합니다.', 'OBV가 OBV 20봉 SMA를 상향 교차한 날을 찾을 수 있습니다.',
      '실제 투자자별 자금 유입액은 측정하지 않습니다. 누적 시작점이 다른 종목의 절대값은 비교하기 어렵습니다.'),
  },
  {
    id: 'mfi', name: 'MFI 자금흐름지수', shortName: 'MFI', pane: 'lower',
    fields: [period('period', '기간', 14), ...levels(), color('color', 'MFI 색상', '#2ea986')],
    help: help('고가·저가·종가 평균과 거래량으로 계산한 0~100 지표입니다.',
      ['기간: 양·음 흐름을 합산하는 봉 수. 기준선과 선 색상은 표시를 조절합니다.'],
      '한쪽 흐름이 우세한 구간과 기준선에서 이탈하는 움직임을 함께 봅니다.', 'MFI ≤ 20인 확정 일봉을 다른 조건과 조합할 수 있습니다.',
      '실제 투자자별 매수·매도금액이 아닙니다. 과열이 즉시 반전을 보장하지 않으며, 거래량이 누락됐거나 양·음 흐름이 모두 0이면 값이 없습니다.'),
  },
  {
    id: 'cci', name: 'CCI 상품채널지수', shortName: 'CCI', pane: 'lower',
    fields: [period('period', '기간', 20), choice('source', '가격 소스', 'hlc3', { hlc3: 'HLC3 (고가·저가·종가 평균)', close: '종가' }),
      number('lower', '하단 기준', -100, -1000, 1000), number('middle', '중앙 기준', 0, -1000, 1000), number('upper', '상단 기준', 100, -1000, 1000),
      color('color', 'CCI 색상', '#4b86ff')],
    help: help('가격이 평균에서 얼마나 벗어났는지 같은 구간의 평균절대편차로 나타냅니다.',
      ['기간과 가격 소스(종가 또는 HLC3)를 고릅니다.', '세 기준선과 선 색상은 표시를 조절합니다.'],
      '0과 ±100은 참고선이며 차트 범위는 실제 값에 따라 달라집니다.', 'CCI가 −100을 상향 교차한 확정 일봉을 찾을 수 있습니다.',
      '값의 상·하한은 고정돼 있지 않습니다. 평균절대편차가 0이면 계산값이 없습니다.'),
  },
  {
    id: 'supertrend', name: '슈퍼트렌드', shortName: 'Supertrend', pane: 'price',
    fields: [period('period', 'ATR 기간', 10), number('multiplier', 'ATR 배수', 3, 0.1, 20, 0.1),
      color('upColor', '상승선 색상', '#db5661'), color('downColor', '하락선 색상', '#4385e5'), toggle('showFlips', '방향 전환 표시')],
    help: help('ATR 밴드와 이전 봉의 추세를 함께 사용해 가격 위나 아래에 추세선을 표시합니다.',
      ['ATR 기간과 배수는 밴드 거리와 반응 속도에 영향을 줍니다.', '상승·하락선 색상과 방향 전환 표시를 선택합니다.'],
      '가격과 선의 상대 위치 및 방향이 바뀐 봉을 확인합니다.', '슈퍼트렌드가 상승 방향으로 전환된 확정 일봉을 조건으로 검색할 수 있습니다.',
      '과거 봉을 사용하는 지표이며 진행 중인 봉에서는 방향이나 가격이 달라질 수 있습니다. 전환 표시는 조건 기록입니다.'),
  },
]

export const ADVANCED_BY_ID = Object.fromEntries(ADVANCED_INDICATORS.map(item => [item.id, item]))
export const ADVANCED_DEFAULTS = Object.fromEntries(ADVANCED_INDICATORS.map(({ id, fields }) => [id,
  Object.fromEntries(fields.map(({ key, value }) => [key, value])),
]))

export function validAdvancedConfig(config) {
  const spec = ADVANCED_BY_ID[config.id]
  if (!spec || !spec.fields.every(field => {
    const value = config[field.key]
    if (field.options) return Object.hasOwn(field.options, value)
    if (field.color) return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
    if (typeof field.value === 'boolean') return typeof value === 'boolean'
    return Number.isFinite(value) && value >= field.min && value <= field.max && (field.step !== 1 || Number.isInteger(value))
  })) return false
  return (!('lower' in config) || config.lower < config.upper)
    && (config.id !== 'cci' || (config.lower < config.middle && config.middle < config.upper))
}
