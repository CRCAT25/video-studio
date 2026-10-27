// Hộp xác nhận chi phí trước khi chạy bước tốn tiền (gửi allowPaid:true chỉ khi bạn đồng ý).
import Modal from './Modal.jsx';
import { fmtNum } from '../lib/format.js';
import { useT } from '../lib/i18n.jsx';

// cost = {service, estimate, estimate_value, unit}; Hủy không gọi API nào.
export default function CostModal({ stepName, cost, withFeedback = false, busy = false, onConfirm, onClose }) {
  const t = useT();
  const c = cost || {};
  const hasVal = c.estimate_value != null && !Number.isNaN(Number(c.estimate_value));
  return (
    <Modal title={t('Xác nhận chi phí')} paid onClose={onClose} busy={busy} lead={withFeedback ? t('Bước "{n}" sẽ chạy lại kèm góp ý và gọi dịch vụ trả phí.', { n: stepName }) : t('Bước "{n}" gọi dịch vụ trả phí.', { n: stepName })}>
      <div className="cost-box">
        <div className="svc">{c.service || t('Dịch vụ không rõ')}</div>
        <div className="est">
          {hasVal ? fmtNum(c.estimate_value) : '—'}
          <small>{hasVal ? c.unit || '' : t('chưa ước tính được')}</small>
        </div>
        {c.estimate != null && c.estimate !== '' ? (
          <div className="mono dim wrap-any">{t('Cách tính:')} {String(c.estimate)}</div>
        ) : null}
        <p>{t('Sẽ trừ tiền/credit thật trong tài khoản {s}.', { s: c.service || t('dịch vụ') })}</p>
      </div>
      {!hasVal ? <p className="note">{t('Chưa ước tính được — kiểm tra đầu vào ở bước trước.')}</p> : null}
      <div className="modal-acts">
        <button type="button" className="btn" onClick={onClose} disabled={busy} data-autofocus>
          {t('Hủy')}
        </button>
        <button type="button" className="btn paid" onClick={onConfirm} disabled={busy} data-ai="block">
          {busy ? <span className="spinner" aria-hidden="true" /> : '$'} {t('Đồng ý, chạy')}
        </button>
      </div>
    </Modal>
  );
}
