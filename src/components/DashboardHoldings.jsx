import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import useAssetAccounts from '../hooks/useAssetAccounts'
import { BROKERS, getBroker } from '../utils/brokers'
import { hasAmount, summarizeAssets, toggleAssetBroker } from '../utils/assetSummary'

const number = value => new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(value)
const signedAmount = value => hasAmount(value) ? `${value > 0 ? '+' : ''}${number(value)}원` : '—'

export default function DashboardHoldings({ currentUser, integrationStatus, integrationVersion, selected, onSelectedChange }) {
  const [accountSelection, setAccountSelection] = useState(null)
  const accountIds = accountSelection?.version === integrationVersion ? accountSelection.ids : {}
  const [refreshVersion, setRefreshVersion] = useState(0)
  const accounts = useAssetAccounts({ userId: currentUser?.id, selected, integrationStatus, integrationVersion, refreshVersion, accountIds })
  const { holdings, readyCount } = summarizeAssets(selected, accounts)
  const loading = selected.some(id => accounts[id].status === 'loading')

  return <article className="panel holdings dashboard-holdings">
    <div className="panel-head dashboard-holdings-head">
      <div><h2>보유종목</h2></div>
      <div className="holdings-broker-tabs" role="group" aria-label="보유종목 증권사 선택">
        {BROKERS.map(broker => {
          const active = selected.includes(broker.id)
          return <button type="button" key={broker.id} aria-pressed={active} className={active ? `active ${broker.id}` : ''} onClick={() => onSelectedChange(value => toggleAssetBroker(value, broker.id, { allowEmpty: true }))}>
            {broker.shortName}
          </button>
        })}
      </div>
    </div>
    <div className="dashboard-holdings-tools">
      <small>{selected.length}개 선택</small>
      <button type="button" aria-label="보유종목 새로고침" disabled={!currentUser || !selected.length || loading} onClick={() => setRefreshVersion(value => value + 1)}><RefreshCw size={12}/>새로고침</button>
    </div>
    {!selected.length ? <div className="data-message" role="status">증권사를 선택해주세요</div> : !currentUser ? <div className="data-message">로그인 시 보유종목이 표시됩니다.</div> : <>
      <div className="dashboard-holdings-accounts">
        {BROKERS.filter(broker => selected.includes(broker.id) && accounts[broker.id].accounts.length > 1).map(broker => {
          const account = accounts[broker.id]
          return <label key={broker.id}>{broker.shortName} 조회 계좌<select aria-label={`${broker.name} 보유종목 조회 계좌`} value={accountIds[broker.id] || ''} disabled={account.status === 'loading'} onChange={event => setAccountSelection({ version: integrationVersion, ids: { ...accountIds, [broker.id]: event.target.value } })}>
              <option value="" disabled>계좌 선택</option>{account.accounts.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select></label>
        })}
      </div>
      {!holdings.length ? <div className="data-message">{loading ? '선택한 증권사 보유종목을 조회하고 있습니다.' : readyCount === selected.length ? '선택한 증권사에 보유종목이 없습니다.' : '선택한 증권사의 보유종목을 확인할 수 없습니다.'}</div> : <div className="dashboard-holdings-table">
        <div className="dashboard-holding-row head"><span>증권사 · 종목</span><span>보유수량</span><span>수익률</span><span>평가손익</span></div>
        <div className="dashboard-holding-scroll">{holdings.map((item, index) => <div className="dashboard-holding-row" key={`${item.broker}:${item.code}:${index}`}>
          <span><span className={`broker-holding-badge ${item.broker}`}>{getBroker(item.broker).shortName}</span><strong>{item.name}</strong><small>{item.code}</small></span>
          <span>{hasAmount(item.quantity) ? `${number(item.quantity)}주` : '—'}</span>
          <span className={hasAmount(item.profitRate) ? item.profitRate >= 0 ? 'up' : 'down' : ''}>{hasAmount(item.profitRate) ? `${item.profitRate > 0 ? '+' : ''}${item.profitRate.toFixed(2)}%` : '—'}</span>
          <span className={hasAmount(item.evaluationProfit) ? item.evaluationProfit >= 0 ? 'up' : 'down' : ''}>{signedAmount(item.evaluationProfit)}</span>
        </div>)}</div>
      </div>}
    </>}
  </article>
}
