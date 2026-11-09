const statusMessages = {
  disconnected: '데이터 연결 준비 중',
  loading: '데이터를 불러오고 있습니다.',
  empty: '표시할 데이터가 없습니다.',
  error: '데이터를 불러오지 못했습니다.',
}

export function CompanyDataStatus({ status = 'disconnected', message }) {
  if (status === 'ready') return null
  return <p className={`company-data-status ${status}`} role={status === 'error' ? 'alert' : 'status'}>
    {message ?? statusMessages[status]}
  </p>
}

export function CompanyCard({ title, children }) {
  return <section className="panel company-card">
    <h3>{title}</h3>
    {children}
  </section>
}

export function CompanyValues({ labels, values = {} }) {
  return <dl className="company-values">
    {labels.map(label => <div key={label}><dt>{label}</dt><dd>{values[label] ?? '—'}</dd></div>)}
  </dl>
}

export function CompanyMetadata({ fields }) {
  return <dl className="company-metadata">
    {Object.entries(fields).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? '—'}</dd></div>)}
  </dl>
}

export function CompanyTableRegion({ label, children }) {
  return <div className="company-table-scroll" role="region" aria-label={`${label} 표 스크롤 영역`} tabIndex={0}>
    <table aria-label={label}>{children}</table>
  </div>
}

export function CompanyDataTable({ label, columns, status = 'disconnected', message, children }) {
  return <CompanyTableRegion label={label}>
    <thead><tr>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
    <tbody>{status === 'ready' ? children : <tr>
      <td colSpan={columns.length}><CompanyDataStatus status={status} message={message}/></td>
    </tr>}</tbody>
  </CompanyTableRegion>
}
