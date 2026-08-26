import { LogOut, X } from 'lucide-react'

export default function ConfirmDialog({ open, pending = false, onCancel, onConfirm }) {
  if (!open) return null

  return (
    <div className="auth-overlay confirm-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onCancel() }}>
      <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="logout-confirm-title" aria-describedby="logout-confirm-description">
        <button type="button" className="auth-close" aria-label="확인 창 닫기" onClick={onCancel} disabled={pending}><X/></button>
        <span className="confirm-icon"><LogOut/></span>
        <h2 id="logout-confirm-title">로그아웃하시겠습니까?</h2>
        <p id="logout-confirm-description">저장하지 않은 설정은 사라지며 게스트 화면으로 돌아갑니다.</p>
        <div className="confirm-actions">
          <button type="button" onClick={onCancel} disabled={pending}>취소</button>
          <button type="button" className="danger" onClick={onConfirm} disabled={pending}>{pending ? '로그아웃 중...' : '로그아웃'}</button>
        </div>
      </section>
    </div>
  )
}
