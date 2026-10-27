// Hộp thoại "Đặt lại toàn bộ": gõ RESET để xác nhận → server gỡ kênh YouTube, chuyển dữ liệu sang bản sao lưu và mở lại như mới cài.
import { useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../api.js';
import { useToast } from './Toast.jsx';
import { useT } from '../lib/i18n.jsx';

// running = số bước đang chạy (server từ chối đặt lại khi còn bước chạy).
export default function ResetModal({ running = 0, onClose }) {
  const t = useT();
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  // Chờ server mở lại (boot đổi) rồi tải lại trang; app chạy không có tiến trình cha thì chỉ báo tự mở lại.
  const go = async () => {
    setBusy(true);
    try {
      const before = await api.health().catch(() => null);
      const r = await api.resetAll();
      setDone(r);
      if (!r.restarting) return;
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        const h = await api.health().catch(() => null);
        if (h?.boot && h.boot !== before?.boot) return window.location.assign('/');
      }
    } catch (e) {
      toast(e.message, 'err');
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Modal title={t('Đã đặt lại')} onClose={() => {}} busy>
        <p>{done.restarting ? t('Đang khởi động lại như mới cài…') : t('Đã xong. Hãy chạy lại app (npm start) để bắt đầu như mới cài.')}</p>
        <p className="note">{t('Dữ liệu cũ được giữ tại:')} <code>{done.backup}</code></p>
      </Modal>
    );
  }
  return (
    <Modal title={t('Đặt lại toàn bộ?')} lead={t('App sẽ về như mới cài.')} onClose={onClose} busy={busy} paid>
      <ul className="note">
        <li>{t('Xóa mọi dự án, quy trình đã lưu, mật khẩu và lịch sử trợ lý AI.')}</li>
        <li>{t('Gỡ mọi kênh YouTube và thiết lập Google (thu hồi quyền ở Google).')}</li>
        <li>{t('Không đăng xuất Claude Code. Dữ liệu cũ được chuyển sang một thư mục sao lưu, không bị xóa hẳn.')}</li>
      </ul>
      {running > 0 ? <p className="note">{t('Đang có bước chạy — đợi xong hoặc bấm Dừng trước.')}</p> : null}
      <label className="fld">
        <span>{t('Gõ "RESET" để xác nhận')}</span>
        <input type="text" data-autofocus value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <div className="modal-acts">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('Hủy')}</button>
        <button type="button" className="btn danger" onClick={go} disabled={busy || text !== 'RESET' || running > 0}>{t('Đặt lại toàn bộ')}</button>
      </div>
    </Modal>
  );
}
