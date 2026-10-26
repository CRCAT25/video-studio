// Hộp thoại "Dự án mới": chọn preset (nhóm theo kênh), tiêu đề; slug + thư mục nằm trong "Tùy chọn nâng cao".
import { useMemo, useState } from 'react';
import Modal from './Modal.jsx';
import Flow from './Flow.jsx';
import Select from './Select.jsx';
import { api } from '../api.js';
import { isValidSlug, slugify } from '../lib/slug.js';

const TITLE_MAX = 200;

// Ghép đường dẫn xem trước giống server: thay {slug}; "~" giữ nguyên (server mở thành thư mục nhà của máy);
// đường dẫn tương đối → nằm trong home của Video Studio ($VS_HOME, lấy từ /api/doctor).
export function previewDir(template, slug, home) {
  let d = String(template || '').split('{slug}').join(slug || '…');
  const h = home ? String(home).replace(/\/+$/, '') : '';
  if (!d.startsWith('/') && !d.startsWith('~') && h) d = `${h}/${d.replace(/^\.\//, '')}`;
  return d;
}

function groupPresets(presets, channels) {
  const names = new Map((channels || []).map((c) => [c.id, c.name]));
  const groups = new Map();
  for (const p of presets) {
    const k = p.channel && names.has(p.channel) ? p.channel : p.channel || '';
    if (!groups.has(k)) groups.set(k, { label: names.get(k) || (k ? `Kênh ${k}` : 'Không gắn kênh'), items: [] });
    groups.get(k).items.push(p);
  }
  return [...groups.values()];
}

// Hiển thị modal; onCreated(project) sau khi tạo xong.
export default function NewProjectModal({ presetsData, channels, doctor, onClose, onCreated }) {
  const presets = presetsData?.presets || [];
  const loadErrors = presetsData?.errors || [];
  const [presetId, setPresetId] = useState(() => presets[0]?.id || '');
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [useDir, setUseDir] = useState(false);
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [adv, setAdv] = useState(false);

  const preset = presets.find((p) => p.id === presetId) || null;
  const groups = useMemo(() => groupPresets(presets, channels), [presets, channels]);
  const autoSlug = slugify(title);
  const effSlug = slugEdited ? slug : title.trim() ? autoSlug : '';
  const titleT = title.trim();
  const titleBad = titleT.length > TITLE_MAX;
  const slugBad = slugEdited && !isValidSlug(slug);
  const dirT = dir.trim();
  const dirBad = useDir && dirT !== '' && !(dirT.startsWith('/') || dirT.startsWith('~'));
  const home = doctor?.home || '';
  const shownDir = useDir ? (dirT ? previewDir(dirT, effSlug, home) : '') : previewDir(preset?.project_dir || 'projects/{slug}', effSlug, home);
  const canSubmit = !!preset && titleT.length > 0 && !titleBad && !slugBad && (!useDir || (dirT && !dirBad)) && !busy;
  const fieldErr = (codes) => (err && codes.includes(err.code) ? err.message : null);

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      const body = { presetId, title: titleT };
      if (slugEdited) body.slug = slug;
      if (useDir && dirT) body.dir = dirT;
      const view = await api.createProject(body);
      onCreated?.(view);
    } catch (e2) {
      setErr({ code: e2.code, message: e2.message });
      if (['invalid_slug', 'slug_taken', 'invalid_dir', 'dir_taken'].includes(e2.code)) setAdv(true);
      setBusy(false);
    }
  };

  if (presets.length === 0) {
    return (
      <Modal title="Dự án mới" onClose={onClose}>
        <p className="note">
          Chưa có preset. Thêm file <span className="mono">.yaml</span> vào thư mục <span className="mono">presets/</span> rồi mở lại.
        </p>
        {loadErrors.length ? <PresetErrors errors={loadErrors} /> : null}
        <div className="modal-acts">
          <button type="button" className="btn" onClick={onClose}>
            Đóng
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Dự án mới" wide onClose={onClose} busy={busy}>
      <form onSubmit={submit} noValidate>
        <label className="fld">
          <span>Preset</span>
          <Select
            value={presetId}
            options={groups.flatMap((g) => g.items.map((p) => ({ value: p.id, label: p.name, meta: `${p.steps?.length || 0} bước`, group: g.label })))}
            onChange={setPresetId}
            disabled={busy}
          />
        </label>
        <label className="fld">
          <span>Tiêu đề video</span>
          <input type="text" value={title} maxLength={TITLE_MAX + 20} onChange={(e) => setTitle(e.target.value)} placeholder="Vd: Mua vàng hay gửi tiết kiệm?" disabled={busy} data-autofocus />
          {titleBad ? <span className="hint bad">Tiêu đề tối đa {TITLE_MAX} ký tự.</span> : null}
          {fieldErr(['invalid_title']) ? <span className="hint bad">{fieldErr(['invalid_title'])}</span> : null}
        </label>
        <details className="adv" open={adv} onToggle={(e) => setAdv(e.currentTarget.open)}>
          <summary>Tùy chọn nâng cao</summary>
          <div className="fld">
            <span className="fld-l">Slug</span>
            <div className="acts" style={{ flexWrap: 'nowrap' }}>
              <input
                type="text"
                className="mono-in"
                style={{ flex: 1, minWidth: 0 }}
                value={effSlug}
                placeholder="tu-dong-theo-tieu-de"
                onChange={(e) => {
                  setSlugEdited(true);
                  setSlug(e.target.value.toLowerCase());
                }}
                disabled={busy}
                aria-invalid={slugBad || !!fieldErr(['invalid_slug', 'slug_taken'])}
                aria-label="Slug"
              />
              {slugEdited ? (
                <button type="button" className="btn sm" onClick={() => setSlugEdited(false)} disabled={busy} title="Sinh lại slug từ tiêu đề">
                  Theo tiêu đề
                </button>
              ) : null}
            </div>
            {slugBad ? (
              <span className="hint bad">Chỉ a–z, 0–9 và "-", tối đa 64 ký tự.</span>
            ) : fieldErr(['invalid_slug', 'slug_taken']) ? (
              <span className="hint bad">{fieldErr(['invalid_slug', 'slug_taken'])}</span>
            ) : (
              <span className="hint">Dùng làm tên thư mục.</span>
            )}
          </div>
          <div className="fld">
            <span className="fld-l">Thư mục dự án</span>
            {shownDir ? <div className="dirprev">{shownDir}</div> : <div className="dirprev dim">Nhập đường dẫn bên dưới</div>}
            <label className="chk">
              <input type="checkbox" checked={useDir} onChange={(e) => setUseDir(e.target.checked)} disabled={busy} />
              <span>Dùng thư mục khác (vd: dự án có sẵn)</span>
            </label>
            {useDir ? (
              <input type="text" className="mono-in" style={{ width: '100%', marginTop: 8 }} value={dir} onChange={(e) => setDir(e.target.value)} placeholder="~/Documents/Youtube/du-an-cu" disabled={busy} aria-label="Thư mục dự án" />
            ) : null}
            {dirBad ? <span className="hint bad">Cần đường dẫn tuyệt đối (bắt đầu bằng / hoặc ~).</span> : null}
            {fieldErr(['invalid_dir', 'dir_taken']) ? <span className="hint bad">{fieldErr(['invalid_dir', 'dir_taken'])}</span> : null}
          </div>
        </details>
        {preset?.steps?.length ? (
          <div className="fld">
            <span className="fld-l">{preset.steps.length} bước</span>
            <div className="prev-belt">
              <Flow steps={preset.steps} staticMode label={`Các bước của preset ${preset.name}`} />
            </div>
          </div>
        ) : null}
        {loadErrors.length ? <PresetErrors errors={loadErrors} /> : null}
        {err && !fieldErr(['invalid_title', 'invalid_slug', 'slug_taken', 'invalid_dir', 'dir_taken']) ? (
          <div className="err-note" role="alert">
            {err.message}
          </div>
        ) : null}
        <div className="modal-acts">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          <button type="submit" className="btn primary" disabled={!canSubmit}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}Tạo dự án
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Danh sách file preset bị lỗi khi nạp.
export function PresetErrors({ errors }) {
  return (
    <div className="warn-note" style={{ marginTop: 10 }}>
      <b>{errors.length} preset bị lỗi:</b>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        {errors.map((e, i) => (
          <li key={i}>
            <span className="mono" title={e.file}>{String(e.file || '').split('/').pop()}</span> —{' '}
            <span style={{ whiteSpace: 'pre-line' }}>{e.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
