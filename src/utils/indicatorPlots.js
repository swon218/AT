export function advancedPlot(config) {
  const single = (key, unit, levels = [], bounded = false) => ({ lines: [[key, config.color, key.toUpperCase()]], unit, levels, bounded })
  switch (config.id) {
    case 'atr': return config.display === 'percent' ? single('atr_percent', '%') : single('atr', '원')
    case 'dmi': return {
      lines: [config.showAdx && ['adx', config.adxColor, 'ADX'], config.showPlus && ['plus_di', config.plusColor, '+DI'], config.showMinus && ['minus_di', config.minusColor, '−DI']].filter(Boolean),
      levels: config.showLevels ? [config.lower, config.upper] : [], bounded: true, unit: '',
    }
    case 'stochastic': return { lines: [['stoch_k', config.kColor, '%K'], ['stoch_d', config.dColor, '%D']], levels: [config.lower, config.upper], bounded: true, unit: '' }
    case 'obv': return { lines: [['obv', config.color, 'OBV'], ...(config.showAverage ? [['obv_ma', config.maColor, `OBV ${config.maType}`]] : [])], levels: [], unit: '주' }
    case 'mfi': return single('mfi', '', [config.lower, config.upper], true)
    case 'cci': return single('cci', '', [config.lower, config.middle, config.upper])
    default: return null
  }
}

// LineSeries interpolates across whitespace. The outgoing stroke before a
// missing value is transparent, so a gap/another trend doesn't join segments.
export function alignedPlot(candles, values, visible = () => true) {
  const hasValue = i => Number.isFinite(values[i]) && visible(i)
  return candles.map(({ time }, i) => hasValue(i)
    ? { time, value: values[i], ...(i + 1 < candles.length && !hasValue(i + 1) ? { color: 'transparent' } : {}) }
    : { time })
}
