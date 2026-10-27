// Hộp thoại sửa CLAUDE.md + memory của Claude Code, và quản lý MCP server (mở từ /memory, /mcp hoặc menu ⋯ của Trợ lý AI).
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import Modal from './Modal.jsx';
import Select from './Select.jsx';
import { useT } from '../lib/i18n.jsx';

// Sửa CLAUDE.md / memory: chọn tệp ở trên, soạn ở dưới, Lưu ghi thẳng vào ~/.claude.
export function MemoryModal({ onClose }) {
  const t = useT();
  const [files, setFiles] = useState(null);
  const [id, setId] = useState('claude-md');
  const [text, setText] = useState('');
  const [orig, setOrig] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.claudeFiles().then((r) => setFiles(r.files), (e) => setErr(e.message));
  }, []);
  useEffect(() => {
    setLoaded(false);
    api.claudeFile(id).then(
      (r) => {
        setText(r.text);
        setOrig(r.text);
        setLoaded(true);
        setErr(null);
      },
      (e) => setErr(e.message),
    );
  }, [id]);

  const dirty = loaded && text !== orig;
  const save = async () => {
    setSaving(true);
    try {
      await api.claudeFileSave(id, text);
      setOrig(text);
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };
  const opts = (files || [{ id: 'claude-md', name: 'CLAUDE.md', group: 'global' }]).map((f) => ({ value: f.id, label: f.id === 'claude-md' ? 'CLAUDE.md' : `${f.group.replace(/^-Users-[^-]+-?/, '') || '~'} / ${f.name}` }));
  return createPortal(
    <Modal title={t('CLAUDE.md và memory')} lead={t('Sửa trực tiếp các tệp Claude Code đọc mỗi lần chạy.')} wide onClose={onClose} busy={saving}>
      <Select value={id} options={opts} label={t('Tệp')} onChange={(v) => !dirty || window.confirm(t('Bỏ thay đổi chưa lưu?')) ? setId(v) : null} />
      <textarea className="mono" rows={16} style={{ width: '100%', marginTop: 8 }} value={text} disabled={!loaded} onChange={(e) => setText(e.target.value)} aria-label={t('Nội dung')} spellCheck={false} />
      {err ? <div className="ai-msg ai-err">{err}</div> : null}
      <div className="modal-acts">
        <button type="button" className="btn" onClick={onClose} disabled={saving}>{t('Đóng')}</button>
        <button type="button" className="btn primary" onClick={save} disabled={!dirty || saving}>{saving ? <span className="spinner" aria-hidden="true" /> : null} {t('Lưu')}</button>
      </div>
    </Modal>,
    document.body,
  );
}

// Danh sách MCP server (giá trị env/headers không hiện), thêm / xóa qua `claude mcp`.
export function McpModal({ onClose }) {
  const t = useT();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ name: '', type: 'stdio', target: '' });

  useEffect(() => {
    api.mcpList().then((r) => setRows(r.servers), (e) => setErr(e.message));
  }, []);
  const run = async (fn) => {
    setBusy(true);
    setErr(null);
    try {
      setRows((await fn()).servers);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const add = () => run(async () => {
    const parts = f.target.trim().split(/\s+/);
    const r = await api.mcpAdd(f.type === 'stdio' ? { name: f.name.trim(), type: 'stdio', target: parts[0], args: parts.slice(1) } : { name: f.name.trim(), type: f.type, target: f.target.trim() });
    setF({ name: '', type: 'stdio', target: '' });
    return r;
  });
  return createPortal(
    <Modal title={t('MCP server')} lead={t('Công cụ ngoài mà Claude Code kết nối. Giá trị khóa (env, header) không hiển thị ở đây.')} wide onClose={onClose} busy={busy}>
      {rows == null ? <p className="note">{t('Đang tải…')}</p> : !rows.length ? <p className="note">{t('Chưa có MCP server nào.')}</p> : (
        <div role="list">
          {rows.map((r) => (
            <div key={`${r.scope}/${r.name}`} className="ai-hist-row" role="listitem">
              <div className="ai-hist-open" style={{ cursor: 'default' }}>
                <span className="ai-hist-t"><b>{r.name}</b> · {r.type} · {r.scope}</span>
                <span className="ai-hist-d mono">{r.target}{r.env ? ` · env ${r.env}` : ''}{r.headers ? ` · header ${r.headers}` : ''}</span>
              </div>
              <button type="button" className="btn sm" disabled={busy} onClick={() => window.confirm(t('Xóa MCP "{n}"?', { n: r.name })) && run(() => api.mcpRemove(r.name, r.scope === 'user' ? 'user' : 'local'))}>{t('Xóa')}</button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={t('Tên')} aria-label={t('Tên')} style={{ width: 110 }} />
        <Select size="sm" value={f.type} options={[{ value: 'stdio', label: 'stdio' }, { value: 'http', label: 'http' }, { value: 'sse', label: 'sse' }]} label={t('Loại')} onChange={(v) => setF({ ...f, type: v })} />
        <input value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} placeholder={f.type === 'stdio' ? t('Lệnh và đối số') : 'https://…'} aria-label={t('Lệnh hoặc URL')} style={{ flex: 1, minWidth: 160 }} />
        <button type="button" className="btn sm primary" onClick={add} disabled={busy || !f.name.trim() || !f.target.trim()}>{t('Thêm')}</button>
      </div>
      {err ? <div className="ai-msg ai-err">{err}</div> : null}
      <div className="modal-acts"><button type="button" className="btn" onClick={onClose} disabled={busy}>{t('Đóng')}</button></div>
    </Modal>,
    document.body,
  );
}
