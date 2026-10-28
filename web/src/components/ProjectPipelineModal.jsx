// Sửa quy trình của MỘT dự án đang làm (bản sao riêng, không đổi "Quy trình của tôi"); bước đã chạy bị khóa.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Modal from './Modal.jsx';
import StepEditor, { stepProblem } from './StepEditor.jsx';
import { useCatalog } from './FormatPicker.jsx';
import { useToast } from './Toast.jsx';
import { useT } from '../lib/i18n.jsx';

export default function ProjectPipelineModal({ projectId, onClose, onSaved }) {
  const t = useT();
  const toast = useToast();
  const { catalog } = useCatalog();
  const [draft, setDraft] = useState(null);
  const [locked, setLocked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api.projectPipeline(projectId).then(
      (r) => {
        setDraft(r.pipeline);
        setLocked(r.locked || []);
      },
      (e) => setErr({ message: e.message }),
    );
  }, [projectId]);
  const enabled = (draft?.steps || []).filter((s) => s.enabled !== false);
  const canSave = !!draft && enabled.length > 0 && !enabled.some((s) => stepProblem(s)) && !busy;
  const save = async (e) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    try {
      await api.updateProjectPipeline(projectId, draft);
      toast(t('Đã lưu quy trình của dự án này.'), 'ok');
      onSaved?.();
      onClose();
    } catch (e2) {
      setErr({ message: e2.message, problems: e2.data?.problems || null });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Sửa quy trình của dự án này')} onClose={onClose} busy={busy} wide>
      {!draft || !catalog ? (
        err ? <div className="err-note" role="alert">{err.message}</div> : <span className="spinner" aria-hidden="true" />
      ) : (
        <form onSubmit={save} noValidate className="pe-form">
          <p className="note">{t('Chỉ đổi quy trình của dự án này, không đổi "Quy trình của tôi". Bước đã chạy được giữ nguyên; bạn đổi chỗ, thêm, bớt hoặc sửa các bước chưa chạy.')}</p>
          <StepEditor simple steps={draft.steps} library={catalog.steps} locked={locked} onChange={(steps) => setDraft((d) => ({ ...d, steps }))} disabled={busy} />
          {err ? (
            <div className="err-note" role="alert">
              {err.message}
              {err.problems?.length > 1 ? <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{err.problems.map((m, i) => <li key={i}>{m}</li>)}</ul> : null}
            </div>
          ) : null}
          <div className="modal-acts pe-acts">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('Hủy')}</button>
            <button type="submit" className="btn primary" disabled={!canSave}>
              {busy ? <span className="spinner" aria-hidden="true" /> : null}{t('Lưu')}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
