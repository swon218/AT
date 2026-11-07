import { LockKeyhole, LogIn, LogOut, ShieldCheck } from 'lucide-react'
import { accountAvailability } from '../utils/brokerConnections'

// App owns this footer once, outside page selection. New tabs inherit the dashboard layout.
export default function SidebarFooter({ user, nickname, connections = {}, onProfileClick, onSessionClick }) {
  const availability = accountAvailability(connections)
  return (
    <section className="sidebar-footer" aria-label="계정 및 API 연결 정보">
      <div className="connection-card guest-connection">
        <div className="connection-title"><ShieldCheck/><span>{user ? '사용자 API 범위' : '게스트 API 범위'}</span></div>
        {user ? <>
          {[['kiwoom', '키움 API'], ['toss', '토스 API'], ['nh', 'NH API'], ['kb', 'KB API']].map(([broker, label]) =>
            <div key={broker}><span>{label}</span><b className={connections[broker] === true ? '' : 'blocked'}>{connections[broker] === true ? '연결됨' : '연결안됨'}</b></div>)}
          <div><span><LockKeyhole/>주문·계좌</span><b className={availability === '사용불가' ? 'blocked' : availability === '일부 사용' ? 'partial' : ''}>{availability}</b></div>
        </> : <>
          <div><span><i className="dot kiwoom"/>키움 공개시세</span><b>읽기전용</b></div>
          <div><span><LockKeyhole/>주문·계좌</span><b className="blocked">차단</b></div>
        </>}
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
