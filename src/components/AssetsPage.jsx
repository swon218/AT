import { useState } from 'react'
import { Check, LogIn, RefreshCw } from 'lucide-react'
import { BROKERS, getBroker } from '../utils/brokers'
import { ASSET_METRICS, hasAmount, summarizeAssets, toggleAssetBroker } from '../utils/assetSummary'
import useAssetAccounts from '../hooks/useAssetAccounts'
import './AssetsPage.css'

const number = value => new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(value)
const amount = value => hasAmount(value) ? `${number(value)}원` : '—'
const statusLabel = { guest: '로그인 필요', unconfigured: 'API 미연결', loading: '조회 중', error: '조회 실패', accountRequired: '계좌 선택 필요', ready: '조회 완료' }

export default function AssetsPage({ currentUser, integrationStatus, integrationVersion }) {
  const [selected, setSelected] = useState(() => BROKERS.map(({ id }) => id))
  const [accountSelection, setAccountSelection] = useState(null)
  const accountIds = accountSelection?.version === integrationVersion ? accountSelection.ids : {}
  const [refreshVersion, setRefreshVersion] = useState(0)
  const accounts = useAssetAccounts({ userId: currentUser?.id, selected, integrationStatus, integrationVersion, refreshVersion, accountIds })
  const { metrics, holdings, readyCount } = summarizeAssets(selected, accounts)
  const selectedBrokers = BROKERS.filter(({ id }) => selected.includes(id))
  const loading = selected.some(id => accounts[id].status === 'loading')

  return <>
    <section className="welcome preview-welcome asset-welcome">
      <div><p>{currentUser ? 'MY ACCOUNTS' : 'GUEST PREVIEW'}</p><h1>자산 현황</h1></div>
      <button type="button" className="asset-refresh" disabled={!currentUser || loading} onClick={() => setRefreshVersion(value => value + 1)}><RefreshCw size={14}/>새로고침</button>
    </section>
    <section className="asset-broker-picker" aria-label="자산 현황 증권사 선택">
      <div className="asset-broker-buttons" role="group" aria-label="조회할 증권사">
        {BROKERS.map(broker => {
          const active = selected.includes(broker.id)
          return <button type="button" key={broker.id} aria-pressed={active} disabled={!currentUser || (active && selected.length === 1)} className={`asset-broker-button ${broker.id}${active ? ' selected' : ''}`} onClick={() => setSelected(value => toggleAssetBroker(value, broker.id))}>
            <span className="asset-broker-check">{active && <Check size={13}/>}</span>{broker.name}
          </button>
        })}
      </div>
      <p>{currentUser ? `${selected.length}개 증권사 선택 · 1~4개를 자유롭게 선택할 수 있습니다.` : <><LogIn size={14}/>로그인 후 연결한 증권사의 자산을 확인할 수 있습니다.</>}</p>
    </section>
    {currentUser && <section className="asset-broker-status" aria-label="선택한 증권사 계좌 조회 상태" aria-live="polite">
      {selectedBrokers.map(broker => {
        const account = accounts[broker.id]
        return <div className="asset-status-row" key={broker.id}>
          <strong>{broker.name}</strong><span className={`asset-status ${account.status}`}>{statusLabel[account.status]}</span>
          {account.status === 'unconfigured' && <small>개인 설정에서 API를 연결해 주세요.</small>}
          {account.status === 'error' && <small className="asset-error">{account.error}</small>}
          {account.accounts.length > 1 && <label className="asset-account-picker">조회 계좌<select aria-label={`${broker.name} 조회 계좌`} value={accountIds[broker.id] || ''} disabled={account.status === 'loading'} onChange={event => setAccountSelection({ version: integrationVersion, ids: { ...accountIds, [broker.id]: event.target.value } })}><option value="" disabled>계좌 선택</option>{account.accounts.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>}
        </div>
      })}
    </section>}
    <section className="asset-summary-preview" aria-label="선택 증권사 자산 합계" aria-live="polite">
      {ASSET_METRICS.map(({ label, key }) => {
        const metric = metrics[key]
        return <article className="panel" key={key}><small>{label}</small><strong className="asset-summary-value">{amount(metric.value)}</strong><span className="asset-metric-note">{!currentUser ? '로그인 필요' : metric.count === selected.length ? `선택 ${selected.length}개 증권사 합계` : metric.count ? `${metric.count}/${selected.length}개 증권사 조회 금액 · 부분 합계` : '조회된 금액이 없습니다.'}</span></article>
      })}
    </section>
    <section className="preview-grid asset-preview-grid">
      <article className="panel asset-holdings"><div className="panel-head"><div><h2>보유종목</h2></div><span>조회 완료 {readyCount}/{selected.length}개</span></div>
        {!currentUser ? <div className="data-message">로그인 후 보유종목을 확인할 수 있습니다.</div> : !readyCount ? <div className="data-message">{loading ? '선택한 증권사 계좌를 조회하고 있습니다.' : '증권사 연결 및 계좌 조회 상태를 확인해 주세요.'}</div> : !holdings.length ? <div className="data-message">조회 완료한 증권사에 보유종목이 없습니다.</div> : <div className="asset-holdings-scroll"><table className="asset-holdings-table" aria-label="선택한 증권사 보유종목"><thead><tr><th>증권사</th><th>종목</th><th>보유수량</th><th>평균단가</th><th>평가금액</th><th>수익률</th></tr></thead><tbody>{holdings.map((item, index) => <tr key={`${item.broker}:${item.code}:${index}`}><td><span className={`asset-broker-tag ${item.broker}`}>{getBroker(item.broker).shortName}</span></td><td><strong>{item.name}</strong><small>{item.code}</small></td><td>{hasAmount(item.quantity) ? `${number(item.quantity)}주` : '—'}</td><td>{amount(item.averagePrice)}</td><td>{amount(item.evaluationAmount)}</td><td className={hasAmount(item.profitRate) ? item.profitRate >= 0 ? 'up' : 'down' : ''}>{hasAmount(item.profitRate) ? `${item.profitRate > 0 ? '+' : ''}${number(item.profitRate)}%` : '—'}</td></tr>)}</tbody></table></div>}
      </article>
      <article className="panel"><div className="panel-head"><div><h2>증권사별 자산</h2></div><span>원화 기준</span></div><div className="asset-breakdown">{selectedBrokers.map(broker => <div key={broker.id}><span>{broker.name}</span><strong>{amount(accounts[broker.id].summary?.estimatedAssets)}</strong><small>{statusLabel[accounts[broker.id].status]}</small></div>)}</div></article>
      <article className="panel preview-wide"><div className="panel-head"><div><h2>거래 내역</h2></div><span>준비 중</span></div><div className="data-message">{currentUser ? '거래 내역 조회 기능을 준비하고 있습니다.' : '로그인 후 이용할 수 있습니다.'}</div></article>
    </section>
  </>
}
