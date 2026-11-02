// Hộp thoại "Dự án mới" một màn hình: hỏi đã có ý tưởng chưa (tự nhập / chat với trợ lý) + kênh; phần quy trình (định dạng, bước, skill, tham khảo, nâng cao) thu gọn.
import { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import Flow from './Flow.jsx';
import Select from './Select.jsx';
import FormatPicker, { DEFAULT_FORMAT, FormatPickerSkeleton, flowSteps, useCatalog, useSuggestion } from './FormatPicker.jsx';
import { Sk, SkFlow, SkZone } from './Skeleton.jsx';
import SkillPicker from './SkillPicker.jsx';
import ReferencePicker from './ReferencePicker.jsx';
import WatchVideo from './WatchVideo.jsx';
import IdeaChat from './IdeaChat.jsx';
import Req from './Req.jsx';
import StepEditor, { stepProblem } from './StepEditor.jsx';
import { api } from '../api.js';
import { isValidSlug, slugify } from '../lib/slug.js';
import { tr, useT } from '../lib/i18n.jsx';

const TITLE_MAX = 200;

// Ghép đường dẫn xem trước giống server: thay {slug}; "~" giữ nguyên (server mở thành thư mục nhà của máy);
// đường dẫn tương đối → nằm trong home của Video Studio ($VS_HOME, lấy từ /api/doctor).
export function previewDir(template, slug, home) {
  let d = String(template || '').split('{slug}').join(slug || '…');
  const h = home ? String(home).replace(/\/+$/, '') : '';
  if (!d.startsWith('/') && !d.startsWith('~') && h) d = `${h}/${d.replace(/^\.\//, '')}`;
  return d;
}

const clone = (v) => JSON.parse(JSON.stringify(v));
// Bản nháp để sửa: mọi bước có cờ enabled (bước tắt sẵn giữ false).
const toDraft = (raw) => {
  const d = clone(raw);
  delete d.file;
  delete d.yaml;
  d.steps = (d.steps || []).map((s) => ({ ...s, enabled: s.enabled !== false }));
  return d;
};
const ADV_CODES = ['invalid_slug', 'slug_taken', 'invalid_dir', 'dir_taken'];
const FIELD_CODES = ['invalid_title', 'invalid_name', 'invalid_reference', ...ADV_CODES];

// Hiển thị modal; onCreated(project) sau khi tạo xong.
export default function NewProjectModal({ presetsData, channels, doctor, defaultChannelId = '', onClose, onCreated }) {
  const t = useT();
  const saved = presetsData?.presets || [];
  const loadErrors = presetsData?.errors || [];
  const { catalog, error: catErr } = useCatalog();
  const [mode, setMode] = useState('own'); // own = tự nhập tiêu đề | ai = chat với trợ lý
  const [source, setSource] = useState('suggest'); // suggest | saved
  const [format, setFormat] = useState(DEFAULT_FORMAT);
  const [formatOk, setFormatOk] = useState(true);
  const [savedId, setSavedId] = useState(() => saved[0]?.id || '');
  const sugg = useSuggestion(format);
  const [draft, setDraft] = useState(null);
  const [draftKey, setDraftKey] = useState('');
  const [title, setTitle] = useState('');
  const [channelId, setChannelId] = useState(defaultChannelId);
  const [saveOn, setSaveOn] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [useDir, setUseDir] = useState(false);
  const [dir, setDir] = useState('');
  const [picking, setPicking] = useState(false);
  const [pickErr, setPickErr] = useState('');
  const [reference, setReference] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [custom, setCustom] = useState(false); // mở "Tùy chỉnh quy trình"
  const [adv, setAdv] = useState(false);

  const savedPreset = saved.find((p) => p.id === savedId) || null;
  const chosen = source === 'saved' ? savedPreset?.pipeline || null : sugg.pipeline;
  const chosenKey = source === 'saved' ? `saved:${savedId}` : `suggest:${JSON.stringify(format)}`;
  const ready = !!chosen && (source === 'saved' || (formatOk && !sugg.loading));

  // Đổi nguồn/định dạng thì làm nháp mới; quy trình mặc định tự nạp nên người dùng không cần chọn trước.
  useEffect(() => {
    if (!chosen || draftKey === chosenKey) return;
    setDraft(toDraft(chosen));
    setDraftKey(chosenKey);
    setSaveName(source === 'saved' ? '' : chosen.name || '');
    setSaveOn(false);
    if (source === 'saved' && chosen.channel && (channels || []).some((c) => c.id === chosen.channel)) setChannelId(chosen.channel);
  }, [chosen, chosenKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const autoSlug = slugify(title);
  const effSlug = slugEdited ? slug : title.trim() ? autoSlug : '';
  const titleT = title.trim();
  const titleBad = titleT.length > TITLE_MAX;
  const slugBad = slugEdited && !isValidSlug(slug);
  const dirT = dir.trim();
  const home = doctor?.home || '';
  const shownDir = useDir ? (dirT ? previewDir(dirT, effSlug, home) : '') : previewDir(draft?.project_dir || 'projects/{slug}', effSlug, home);
  const enabled = (draft?.steps || []).filter((s) => s.enabled !== false);
  const stepsBad = !enabled.length || enabled.some((s) => stepProblem(s));
  const saveNameT = saveName.trim();
  const saveBad = saveOn && (!saveNameT || saveNameT.length > 80);
  const canSubmit = !!draft && ready && titleT.length > 0 && !titleBad && !slugBad && !stepsBad && !saveBad && (!useDir || dirT) && !busy;
  const fieldErr = (codes) => (err && codes.includes(err.code) ? err.message : null);
  const chOptions = [{ value: '', label: t('Không gắn kênh') }, ...(channels || []).map((c) => ({ value: c.id, label: c.name || c.id }))];
  const library = catalog?.steps || [];
  const stepName = (id) => (draft?.steps || []).find((s) => s.id === id)?.name || library.find((s) => s.id === id)?.name || id;

  // Áp bố cục trợ lý đề xuất: bước trong danh sách bật theo đúng thứ tự (thiếu thì lấy từ thư viện), bước còn lại tắt.
  const applySteps = (ids) => {
    setDraft((d) => {
      if (!d) return d;
      const pick = (id) => d.steps.find((s) => s.id === id) || (library.find((s) => s.id === id) ? { ...clone(library.find((s) => s.id === id)) } : null);
      const on = ids.map(pick).filter(Boolean).map((s) => ({ ...s, enabled: true }));
      const rest = d.steps.filter((s) => !ids.includes(s.id)).map((s) => ({ ...s, enabled: false }));
      return { ...d, steps: [...on, ...rest] };
    });
    setCustom(true);
  };

  // Mở hộp thoại chọn thư mục của máy (server mở); không cho gõ/dán đường dẫn.
  const pickDirectory = async () => {
    setPicking(true);
    setPickErr('');
    try {
      const r = await api.pickDir();
      if (r?.path) setDir(r.path);
    } catch (e) {
      setPickErr(e.message);
    } finally {
      setPicking(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      // kênh lấy theo ô Kênh, không theo kênh ghi trong quy trình
      const { channel: _ch, ...pipeline } = draft;
      const body = { pipeline, title: titleT };
      if (channelId) body.channelId = channelId;
      if (saveOn) body.saveAs = saveNameT;
      if (slugEdited) body.slug = slug;
      if (useDir && dirT) body.dir = dirT;
      if (reference) body.reference = reference;
      const view = await api.createProject(body);
      onCreated?.(view);
    } catch (e2) {
      setErr({ code: e2.code, message: e2.message, problems: e2.data?.problems || null });
      if (ADV_CODES.includes(e2.code)) { setCustom(true); setAdv(true); }
      else if (['invalid_name', 'invalid_reference'].includes(e2.code)) setCustom(true);
      setBusy(false);
    }
  };

  return (
    <Modal title={t('Dự án mới')} wide aiHelp="new-project" onClose={onClose} busy={busy}>
      <form onSubmit={submit} noValidate>
        <div className="fld">
          <span className="fld-l">{t('Bạn đã có ý tưởng cho dự án này chưa?')}</span>
          <div className="seg src-tabs" role="tablist" aria-label={t('Cách có ý tưởng')}>
            <button type="button" role="tab" aria-selected={mode === 'own'} className={mode === 'own' ? 'on' : ''} onClick={() => setMode('own')} disabled={busy}>
              {t('Đã có, tôi tự nhập')}
            </button>
            <button type="button" role="tab" aria-selected={mode === 'ai'} className={mode === 'ai' ? 'on' : ''} onClick={() => setMode('ai')} disabled={busy}>
              {t('Cùng trợ lý AI tìm ý tưởng')}
            </button>
          </div>
        </div>
        <div className="fld">
          <span className="fld-l">{t('Kênh')}</span>
          <Select value={channelId} options={chOptions} onChange={setChannelId} disabled={busy} label={t('Kênh')} />
          {fieldErr(['channel_not_found']) ? <span className="hint bad">{fieldErr(['channel_not_found'])}</span> : null}
        </div>
        {mode === 'ai' ? (
          <div className="fld">
            <IdeaChat channelId={channelId} onUseIdea={setTitle} onApplySteps={applySteps} stepName={stepName} disabled={busy} />
            <span className="hint">{t('Trợ lý đọc video đã đăng của kênh để gợi ý; chat chỉ dùng trong hộp này, không lưu.')}</span>
          </div>
        ) : null}
        <label className="fld">
          <span>{t('Tiêu đề video')}<Req /></span>
          <input type="text" required aria-required="true" value={title} maxLength={TITLE_MAX + 20} onChange={(e) => setTitle(e.target.value)} placeholder={t('Vd: Mua vàng hay gửi tiết kiệm?')} disabled={busy} data-autofocus />
          {titleBad ? <span className="hint bad">{t('Tiêu đề tối đa {n} ký tự.', { n: TITLE_MAX })}</span> : null}
          {fieldErr(['invalid_title']) ? <span className="hint bad">{fieldErr(['invalid_title'])}</span> : null}
        </label>
        <details className="adv" open={custom} onToggle={(e) => setCustom(e.currentTarget.open)}>
          <summary>
            {t('Tùy chỉnh quy trình')} <span className="muted">· {draft ? t('{n} đang dùng', { n: enabled.length }) : t('Đang tải quy trình gợi ý')}</span>
          </summary>
          {saved.length ? (
            <div className="seg src-tabs" role="tablist" aria-label={t('Nguồn quy trình')}>
              <button type="button" role="tab" aria-selected={source === 'suggest'} className={source === 'suggest' ? 'on' : ''} onClick={() => setSource('suggest')}>
                {t('Gợi ý theo định dạng')}
              </button>
              <button type="button" role="tab" aria-selected={source === 'saved'} className={source === 'saved' ? 'on' : ''} onClick={() => setSource('saved')}>
                {t('Quy trình đã lưu')} <span className="muted">{saved.length}</span>
              </button>
            </div>
          ) : null}
          {source === 'suggest' ? (
            catalog ? (
              <FormatPicker catalog={catalog} value={format} onChange={setFormat} onValidity={setFormatOk} />
            ) : catErr ? (
              <div className="err-note" role="alert">{catErr.message}</div>
            ) : (
              <SkZone label={t('Đang tải định dạng')}>
                <FormatPickerSkeleton />
              </SkZone>
            )
          ) : (
            <div className="saved-list" role="radiogroup" aria-label={t('Quy trình đã lưu')}>
              {saved.map((p) => (
                <label key={p.id} className={`saved-item${p.id === savedId ? ' on' : ''}`}>
                  <input type="radio" name="saved" checked={p.id === savedId} onChange={() => setSavedId(p.id)} />
                  <span className="saved-name">{tr(p.name)}</span>
                  <span className="muted">{t('{n} bước', { n: p.steps?.length || 0 })}</span>
                </label>
              ))}
            </div>
          )}
          {source === 'suggest' && sugg.error ? <div className="err-note" role="alert">{sugg.error.message}</div> : null}
          {draft ? (
            <>
              <div className="fld prev">
                <div className="prev-belt">
                  <Flow steps={flowSteps(draft.steps)} staticMode label={t('Các bước của {n}', { n: draft.name })} />
                </div>
                <span className="hint">{t('Bước tốn tiền luôn hỏi trước khi chạy. Bạn có thể bật/tắt, đổi thứ tự và sửa từng bước.')}</span>
              </div>
              <div className="fld">
                <span className="fld-l">
                  {t('Các bước')} <span className="muted">· {t('{n} đang dùng', { n: enabled.length })}</span>
                </span>
                <StepEditor steps={draft.steps} library={library} onChange={(steps) => setDraft((d) => ({ ...d, steps }))} disabled={busy} />
                {!enabled.length ? <span className="hint bad">{t('Cần ít nhất 1 bước.')}</span> : null}
              </div>
            </>
          ) : source === 'suggest' && !sugg.error ? (
            <SkZone className="fld prev" label={t('Đang tải quy trình gợi ý')}>
              <div className="prev-belt">
                <SkFlow n={7} />
              </div>
            </SkZone>
          ) : null}
          <div className="fld">
            <span className="fld-l">Skills <span className="muted">· {t('chỉ skill được chọn mới nạp cho các bước')}</span></span>
            <SkillPicker channelId={channelId || null} value={draft?.skills || []} onChange={(skills) => setDraft((d) => ({ ...d, skills }))} disabled={busy || !draft} />
          </div>
          <div className="fld">
            <span className="fld-l">{t('Tham khảo video')} <span className="muted">· {t('tùy chọn, dán link YouTube để AI xem rồi bắt chước, hoặc chọn video của kênh')}</span></span>
            <WatchVideo value={reference} onChange={setReference} disabled={busy} />
            <ReferencePicker channels={channels || []} defaultChannelId={channelId} value={reference} onChange={setReference} disabled={busy} />
            {fieldErr(['invalid_reference']) ? <span className="hint bad">{fieldErr(['invalid_reference'])}</span> : null}
          </div>
          <div className="fld">
            <label className="chk">
              <input type="checkbox" checked={saveOn} onChange={(e) => setSaveOn(e.target.checked)} disabled={busy} />
              <span>{t('Lưu làm quy trình của tôi (dùng lại cho dự án sau)')}{saveOn ? <Req /> : null}</span>
            </label>
            {saveOn ? (
              <input type="text" required aria-required="true" style={{ width: '100%', marginTop: 8 }} value={saveName} maxLength={80} onChange={(e) => setSaveName(e.target.value)} placeholder={t('Tên quy trình')} disabled={busy} aria-label={t('Tên quy trình')} aria-invalid={saveBad} />
            ) : null}
            {saveOn && !saveNameT ? <span className="hint bad">{t('Đặt tên cho quy trình.')}</span> : null}
            {fieldErr(['invalid_name']) ? <span className="hint bad">{fieldErr(['invalid_name'])}</span> : null}
          </div>
          <details className="adv" open={adv} onToggle={(e) => setAdv(e.currentTarget.open)}>
            <summary>{t('Tùy chọn nâng cao')}</summary>
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
                  <button type="button" className="btn sm" onClick={() => setSlugEdited(false)} disabled={busy} title={t('Sinh lại slug từ tiêu đề')}>
                    {t('Theo tiêu đề')}
                  </button>
                ) : null}
              </div>
              {slugBad ? (
                <span className="hint bad">{t('Chỉ a–z, 0–9 và "-", tối đa 64 ký tự.')}</span>
              ) : fieldErr(['invalid_slug', 'slug_taken']) ? (
                <span className="hint bad">{fieldErr(['invalid_slug', 'slug_taken'])}</span>
              ) : (
                <span className="hint">{t('Dùng làm tên thư mục.')}</span>
              )}
            </div>
            <div className="fld">
              <span className="fld-l">{t('Thư mục dự án')}</span>
              {shownDir ? <div className="dirprev">{shownDir}</div> : <div className="dirprev dim">{t('Chưa chọn thư mục')}</div>}
              <label className="chk">
                <input type="checkbox" checked={useDir} onChange={(e) => setUseDir(e.target.checked)} disabled={busy} />
                <span>{t('Dùng thư mục khác (vd: dự án có sẵn)')}{useDir ? <Req /> : null}</span>
              </label>
              {useDir ? (
                <div className="dir-row" style={{ marginTop: 8 }}>
                  <button type="button" className="btn sm" onClick={pickDirectory} disabled={busy || picking}>
                    {picking ? <span className="spinner" aria-hidden="true" /> : null}{dirT ? t('Chọn thư mục khác…') : t('Chọn thư mục…')}
                  </button>
                  <span className="hint" style={{ margin: 0 }}>{dirT ? t('Đã chọn thư mục ở trên.') : t('Chưa chọn thư mục — bắt buộc khi dùng thư mục khác.')}</span>
                </div>
              ) : null}
              {pickErr ? <span className="hint bad">{pickErr}</span> : null}
              {fieldErr(['invalid_dir', 'dir_taken']) ? <span className="hint bad">{fieldErr(['invalid_dir', 'dir_taken'])}</span> : null}
            </div>
          </details>
          {loadErrors.length ? <PresetErrors errors={loadErrors} /> : null}
        </details>
        {err && !fieldErr([...FIELD_CODES, 'channel_not_found']) ? (
          <div className="err-note" role="alert">
            {err.message}
            {err.problems?.length > 1 ? (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {err.problems.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            ) : null}
          </div>
        ) : null}
        <div className="modal-acts">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t('Hủy')}
          </button>
          <button type="submit" className="btn primary" disabled={!canSubmit}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}{t('Tạo dự án')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Danh sách file quy trình bị lỗi khi nạp.
export function PresetErrors({ errors }) {
  const t = useT();
  return (
    <div className="warn-note" style={{ marginTop: 10 }}>
      <b>{t('{n} quy trình bị lỗi:', { n: errors.length })}</b>
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
