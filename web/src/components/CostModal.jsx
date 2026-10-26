// Hộp xác nhận chi phí trước khi chạy bước tốn tiền (gửi allowPaid:true chỉ khi bạn đồng ý).
import Modal from './Modal.jsx';
import { fmtNum } from '../lib/format.js';

// cost = {service, estimate, estimate_value, unit}; Hủy không gọi API nào.
export default function CostModal({ stepName, cost, withFeedback = false, busy = false, onConfirm, onClose }) {
  const c = cost || {};
  const hasVal = c.estimate_value != null && !Number.isNaN(Number(c.estimate_value));
  return (
    <Modal title="Xác nhận chi phí" paid onClose={onClose} busy={busy} lead={`Bước "${stepName}" ${withFeedback ? 'sẽ chạy lại kèm góp ý và ' : ''}gọi dịch vụ trả phí.`}>
      <div className="cost-box">
        <div className="svc">{c.service || 'Dịch vụ không rõ'}</div>
        <div className="est">
          {hasVal ? fmtNum(c.estimate_value) : '—'}
          <small>{hasVal ? c.unit || '' : 'chưa ước tính được'}</small>
        </div>
        {c.estimate != null && c.estimate !== '' ? (
          <div className="mono dim wrap-any">Cách tính: {String(c.estimate)}</div>
        ) : null}
        <p>Sẽ trừ tiền/credit thật trong tài khoản {c.service || 'dịch vụ'}.</p>
      </div>
      {!hasVal ? <p className="note">Chưa ước tính được — kiểm tra đầu vào ở bước trước.</p> : null}
      <div className="modal-acts">
        <button type="button" className="btn" onClick={onClose} disabled={busy} data-autofocus>
          Hủy
        </button>
        <button type="button" className="btn paid" onClick={onConfirm} disabled={busy} data-ai="block">
          {busy ? <span className="spinner" aria-hidden="true" /> : '$'} Đồng ý, chạy
        </button>
      </div>
    </Modal>
  );
}
