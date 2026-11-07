import { useState } from 'react'
import useAssetAccounts from '../hooks/useAssetAccounts'
import { BROKERS, getBroker } from '../utils/brokers'
import { hasAmount, summarizeAssets, toggleAssetBroker } from '../utils/assetSummary'

const number = value => new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(value)
const signedAmount = value => hasAmount(value) ? `${value > 0 ? '+' : ''}${number(value)}원` : '—'

export default function DashboardHoldings({ currentUser, integrationStatus, integrationVersion, selected, onSelectedChange, onOpenAssets }) {
  const [accountSelection, setAccountSelection] = useState(null)
  const accountIds = accountSelection?.version === integrationVersion ? accountSelection.ids : {}
  const accounts = useAssetAccounts({ userId: currentUser?.id, selected, integrationStatus, integrationVersion, accountIds })
  const { holdings, readyCount } = summarizeAssets(selected, accounts)
  const loading = selected.some(id => accounts[id].status === 'loading')

  return <article className="panel dashboard-holdings">
    <div className="panel-head dashboard-holdings-head">
      <h2>보유종목</h2>
      <div className="holdings-broker-tabs" role="group" aria-label="보유종목 증권사 선택">
        {BROKERS.map(broker => {
          const active = selected.includes(broker.id)
          return <button type="button" key={broker.id} aria-pressed={active} className={active ? 'active' : ''} onClick={() => onSelectedChange(value => toggleAssetBroker(value, broker.id, { allowEmpty: true }))}>
            {broker.shortName}
          </button>
        })}
      </div>
      <button type="button" className="dashboard-news-more dashboard-holdings-more" aria-label="보유종목 더보기" onClick={onOpenAssets}>더보기</button>
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
      {!holdings.length ? <div className="data-message">{loading ? '선택한 증권사 보유종목을 조회하고 있습니다.' : readyCount === selected.length ? '선택한 증권사에 보유종목이 없습니다.' : '선택한 증권사의 보유종목을 확인할 수 없습니다.'}</div> : <div className="dashboard-holdings-scroll" role="region" aria-label="대시보드 보유종목 스크롤 영역" tabIndex={0}>
        <div className="dashboard-holdings-viewport"><table className="dashboard-holdings-table" aria-label="보유종목 미리보기">
          <thead><tr><th scope="col">증권사 · 종목</th><th scope="col">보유수량</th><th scope="col">수익률</th><th scope="col">평가손익</th></tr></thead>
          <tbody>{holdings.map((item, index) => <tr key={`${item.broker}:${item.code}:${index}`}>
            <td><span className="dashboard-holding-stock"><span className={`broker-holding-badge ${item.broker}`}>{getBroker(item.broker).shortName}</span><strong>{item.name}</strong><small>{item.code}</small></span></td>
            <td>{hasAmount(item.quantity) ? `${number(item.quantity)}주` : '—'}</td>
            <td className={hasAmount(item.profitRate) ? item.profitRate >= 0 ? 'up' : 'down' : ''}>{hasAmount(item.profitRate) ? `${item.profitRate > 0 ? '+' : ''}${item.profitRate.toFixed(2)}%` : '—'}</td>
            <td className={hasAmount(item.evaluationProfit) ? item.evaluationProfit >= 0 ? 'up' : 'down' : ''}>{signedAmount(item.evaluationProfit)}</td>
          </tr>)}</tbody>
        </table></div>
      </div>}
    </>}
  </article>
}
