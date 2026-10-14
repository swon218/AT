import { LockKeyhole, LogIn, LogOut, ShieldCheck } from 'lucide-react'

// App owns this footer once, outside page selection. New tabs inherit the dashboard layout.
export default function SidebarFooter({ user, nickname, integrationStatus, onProfileClick, onSessionClick }) {
  const kiwoomConnected = Boolean(user && integrationStatus.kiwoomConfigured)
  return (
    <section className="sidebar-footer" aria-label="계정 및 API 연결 정보">
      <div className="connection-card guest-connection">
        <div className="connection-title"><ShieldCheck/><span>{user ? '사용자 API 범위' : '게스트 API 범위'}</span></div>
        <div><span><i className="dot kiwoom"/>{kiwoomConnected ? '개인 키움 API' : '키움 공개시세'}</span><b>{kiwoomConnected ? '연결됨' : '읽기전용'}</b></div>
        <div><span><LockKeyhole/>주문·계좌</span><b className={kiwoomConnected ? '' : 'blocked'}>{kiwoomConnected ? '사용가능' : '차단'}</b></div>
      </div>
      <div className="account-profile">
        <button type="button" className="account-profile-main" onClick={onProfileClick} title={user ? '개인 설정' : '로그인'}>
          <span>{nickname?.charAt(0).toUpperCase() || user?.email?.charAt(0).toUpperCase() || 'G'}</span>
          <div><strong>{user ? nickname || '사용자' : '게스트'}</strong><small>{user?.email ?? '로그인 후 개인 기능 사용'}</small></div>
        </button>
        <button type="button" className="account-session-button" onClick={onSessionClick} title={user ? '로그아웃' : '로그인'} aria-label={user ? '로그아웃' : '로그인'}>{user ? <LogOut/> : <LogIn/>}</button>
      </div>
    </section>
  )
}
