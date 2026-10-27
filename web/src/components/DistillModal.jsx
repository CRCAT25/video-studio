// Hộp thoại "Đúc kết thành skill": Claude đọc thành quả của bước đã duyệt và viết bản nháp skill; người dùng xem/sửa rồi mới lưu.
import { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../api.js';
import { useToast } from './Toast.jsx';
import { useT } from '../lib/i18n.jsx';

export default function DistillModal({ projectId, stepKey, stepName, onClose }) {
  const t = useT();
  const toast = useToast();
  const [draft, setDraft] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState('SKILL.md');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);
  const [tries, setTries] = useState(0);

  // Gọi Claude (có thể mất 1–3 phút); đóng hộp thoại giữa chừng thì bỏ kết quả.
  useEffect(() => {
    const ac = new AbortController();
    setDraft(null);
    setErr(null);
    api
      .distillStep(projectId, stepKey, { signal: ac.signal })
      .then((d) => {
        setDraft(d);
        setName(d.name);
        setSel('SKILL.md');
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setErr(e.message);
      });
    return () => ac.abort();
  }, [projectId, stepKey, tries]);

  const setContent = (path, content) => setDraft((d) => ({ ...d, files: d.files.map((f) => (f.path === path ? { ...f, content } : f)) }));
  const dropFile = (path) => {
    setDraft((d) => ({ ...d, files: d.files.filter((f) => f.path !== path) }));
    setSel('SKILL.md');
  };

  const save = async (rename = false) => {
    setSaving(true);
    try {
      const r = await api.saveDistill(projectId, stepKey, { name, files: draft.files, samples: draft.samples, overwrite: !!draft.updates && name === draft.updates, rename });
      setSaved(r);
    } catch (e) {
      if (e.code === 'skill_exists') toast(t('Đã có skill tên "{n}" — đổi tên rồi lưu lại.', { n: name }), 'err');
      else toast(e.message, 'err');
    }
    setSaving(false);
  };

  if (saved) {
    return (
      <Modal title={t('Đã lưu skill')} onClose={onClose}>
        <p>
          <code>{saved.name}</code> {saved.updated ? t('đã được cập nhật.') : t('đã vào thư viện Skills.')}{' '}
          {saved.attached ? t('Đã gắn vào quy trình của dự án này — các lượt chạy sau sẽ dùng nó.') : t('Chưa gắn được vào quy trình — hãy gắn tay ở tab Skills.')}
        </p>
        <div className="modal-acts">
          <button type="button" className="btn primary" onClick={onClose}>{t('Xong')}</button>
        </div>
      </Modal>
    );
  }

  const file = draft?.files.find((f) => f.path === sel);
  return (
    <Modal title={t('Đúc kết thành skill')} lead={t('Bước "{n}" — Claude viết bản nháp, bạn xem rồi mới lưu.', { n: stepName })} onClose={onClose} busy={saving} xwide>
      {err ? (
        <>
          <p className="err-note" role="alert">{err}</p>
          <div className="modal-acts">
            <button type="button" className="btn" onClick={onClose}>{t('Đóng')}</button>
            <button type="button" className="btn primary" onClick={() => setTries((n) => n + 1)}>{t('Thử lại')}</button>
          </div>
        </>
      ) : !draft ? (
        <p className="note"><span className="spinner" aria-hidden="true" /> {t('Claude đang đọc thành quả của bước và viết skill… (có thể mất vài phút, tốn token gói Claude)')}</p>
      ) : (
        <>
          {draft.summary ? <p>{draft.summary}</p> : null}
          {draft.updates ? <p className="note">{t('Sẽ cập nhật skill hiện có "{n}".', { n: draft.updates })}</p> : null}
          <label className="fld">
            <span>{t('Tên skill')}</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
          </label>
          <div className="dst-grid">
            <ul className="dst-files" role="listbox" aria-label={t('File trong skill')}>
              {draft.files.map((f) => (
                <li key={f.path}>
                  <button type="button" role="option" aria-selected={f.path === sel} className={f.path === sel ? 'on' : ''} onClick={() => setSel(f.path)}>{f.path}</button>
                </li>
              ))}
              {draft.samples.map((s) => (
                <li key={s} className="dst-sample" title={t('Ảnh mẫu sẽ được chép vào skill')}>{s}</li>
              ))}
            </ul>
            <div className="dst-edit">
              {file ? <textarea className="mono" value={file.content} onChange={(e) => setContent(file.path, e.target.value)} spellCheck={false} rows={18} aria-label={file.path} /> : null}
              {file && file.path !== 'SKILL.md' ? <button type="button" className="btn" onClick={() => dropFile(file.path)}>{t('Bỏ file này')}</button> : null}
            </div>
          </div>
          <div className="modal-acts">
            <button type="button" className="btn" onClick={onClose} disabled={saving}>{t('Hủy')}</button>
            <button type="button" className="btn" onClick={() => setTries((n) => n + 1)} disabled={saving}>{t('Đúc kết lại')}</button>
            <button type="button" className="btn primary" onClick={() => save(false)} disabled={saving || !name.trim()}>
              {saving ? <span className="spinner" aria-hidden="true" /> : null}{t('Lưu và gắn vào dự án')}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
