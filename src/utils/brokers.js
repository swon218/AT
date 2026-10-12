export const BROKERS = [
  { id: 'kiwoom', name: '키움증권', shortName: '키움', afterHours: true },
  { id: 'toss', name: '토스증권', shortName: '토스', afterHours: false },
  { id: 'nh', name: 'NH투자증권', shortName: 'NH', afterHours: true },
  { id: 'kb', name: 'KB증권', shortName: 'KB', afterHours: true },
]

export function getBroker(id) {
  const broker = BROKERS.find(item => item.id === id)
  if (!broker) throw new Error('지원하지 않는 증권사입니다.')
  return broker
}

export const isBrokerConfigured = (status, broker) => Boolean(status?.[`${getBroker(broker).id}Configured`])
