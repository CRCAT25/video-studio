// Hộp xác nhận trong app thay cho window.confirm; mở được chồng lên hộp thoại khác (portal ra body).
import { useState } from 'react';
import { createPortal } from 'react-dom';
import Modal from './Modal.jsx';
import { useT } from '../lib/i18n.jsx';

// onOk có thể async: chờ xong mới đóng, lỗi thì hiện ngay trong hộp.
export default function ConfirmModal({ title, body, okLabel, danger = false, onOk, onClose }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async () => {
    setBusy(true);
    try {
      await onOk();
      onClose();
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return createPortal(
    <Modal title={title} onClose={onClose} busy={busy}>
      {body ? <p>{body}</p> : null}
      {err ? <div className="err-note" role="alert">{err}</div> : null}
      <div className="modal-acts">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('Hủy')}</button>
        <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} onClick={go} disabled={busy}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null} {okLabel}
        </button>
      </div>
    </Modal>,
    document.body,
  );
}
