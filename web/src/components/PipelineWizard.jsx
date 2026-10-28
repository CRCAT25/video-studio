// Tạo quy trình mới theo 4 bước hỏi-đáp bằng lời thường (chế độ Đơn giản); không gọi AI, không tốn token.
import { useEffect, useMemo, useState } from 'react';
import Flow from './Flow.jsx';
import FormatPicker, { DEFAULT_FORMAT, flowSteps, useCatalog, useSuggestion } from './FormatPicker.jsx';
import Req from './Req.jsx';
import { SkZone } from './Skeleton.jsx';
import { useToast } from './Toast.jsx';
import { api } from '../api.js';
import { applyStyle, styleDefaults } from '../lib/style.js';
import { T, tr, useT } from '../lib/i18n.jsx';

const KINDS = [
  { id: 'short-v', title: T('Video ngắn dọc'), sub: T('TikTok, Reels, YouTube Shorts · khoảng 45 giây'), format: DEFAULT_FORMAT },
  { id: 'short-h', title: T('Video ngắn ngang'), sub: T('Xem trên máy tính, TV · khoảng 45 giây'), format: { orientation: 'horizontal', aspect: '16:9', length: 'short', duration: 45, hd4k: false } },
  { id: 'long-h', title: T('Phim dài trên YouTube'), sub: T('Ngang · khoảng 10 phút'), format: { orientation: 'horizontal', aspect: '16:9', length: 'long', duration: 600, hd4k: false } },
  { id: 'custom', title: T('Tự chọn'), sub: T('Chọn khung hình và thời lượng theo ý bạn'), format: null },
];

const EXTRAS = [
  ['voice', T('Giọng đọc'), T('AI đọc lời dẫn thành tiếng (có thể tốn tiền, luôn hỏi trước)')],
  ['subtitles', T('Phụ đề'), T('Chữ chạy theo lời đọc')],
  ['thumbnail', T('Ảnh bìa (thumbnail)'), T('Ảnh đại diện hiện trước khi người xem bấm vào')],
  ['shorts', T('Cắt thêm video ngắn'), T('Tách vài đoạn hay thành video ngắn để đăng riêng')],
];

export default function PipelineWizard({ onSaved }) {
  const t = useT();
  const toast = useToast();
  const { catalog, error: catErr } = useCatalog();
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState('short-v');
  const [format, setFormat] = useState(DEFAULT_FORMAT);
  const [formatOk, setFormatOk] = useState(true);
  const [opts, setOpts] = useState({});
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const sugg = useSuggestion(format);
  const base = sugg.pipeline;

  // Đổi định dạng → quay về mặc định của quy trình mới và lấy lại tên gợi ý.
  useEffect(() => {
    if (!base) return;
    setOpts({});
    setName(base.name);
    setErr(null);
  }, [base]);

  const draft = useMemo(() => (base && catalog ? applyStyle(base, opts, catalog.steps) : null), [base, opts, catalog]);
  const cur = base ? { ...styleDefaults(base), ...opts } : {};
  const steps = (draft?.steps || []).filter((s) => s.enabled !== false);
  const paid = steps.filter((s) => s.cost).length;
  const nameT = name.trim();
  const canSave = !!draft && formatOk && !sugg.loading && steps.length > 0 && nameT && nameT.length <= 80 && !busy;
  const canNext = step !== 1 || (formatOk && !!base && !sugg.loading);

  const choose = (k) => {
    setKind(k.id);
    if (k.format) setFormat(k.format);
  };

  const save = async (e) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.savePipeline({ ...draft, name: nameT }, nameT);
      toast(t('Đã lưu quy trình "{n}".', { n: r.name }), 'ok');
      setStep(1);
      onSaved?.();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  if (catErr) return <div className="err-note" role="alert">{catErr.message}</div>;
  if (!catalog) return <SkZone className="card wz" label={t('Đang tải gợi ý')}><div style={{ height: 160 }} /></SkZone>;

  const radio = (name2, on, onChange, title, sub) => (
    <label className={`wz-opt${on ? ' on' : ''}`}>
      <input type="radio" name={name2} checked={on} onChange={onChange} disabled={busy} />
      <span><b>{title}</b>{sub ? <small>{sub}</small> : null}</span>
    </label>
  );

  return (
    <form className="card wz" onSubmit={save} noValidate aria-label={t('Tạo quy trình mới')}>
      <ol className="wz-steps" aria-label={t('Các bước tạo quy trình')}>
        {[t('Làm video gì'), t('Cách duyệt'), t('Thêm gì'), t('Đặt tên')].map((l, i) => (
          <li key={l} className={step === i + 1 ? 'on' : step > i + 1 ? 'done' : ''} aria-current={step === i + 1 ? 'step' : undefined}>
            <span>{i + 1}</span>{l}
          </li>
        ))}
      </ol>

      {step === 1 ? (
        <fieldset className="wz-q">
          <legend>{t('Bạn muốn làm video nào?')}</legend>
          <div className="wz-grid">
            {KINDS.map((k) => radio('wz-kind', kind === k.id, () => choose(k), tr(k.title), tr(k.sub)))}
          </div>
          {kind === 'custom' ? <FormatPicker catalog={catalog} value={format} onChange={setFormat} onValidity={setFormatOk} disabled={busy} /> : null}
        </fieldset>
      ) : null}

      {step === 2 ? (
        <fieldset className="wz-q">
          <legend>{t('Bạn muốn duyệt kết quả thế nào?')}</legend>
          <div className="wz-grid">
            {radio('wz-review', cur.review === 'all', () => setOpts((o) => ({ ...o, review: 'all' })), t('Tôi xem từng bước'), t('Xong mỗi bước, hệ thống dừng lại chờ bạn bấm duyệt. An toàn nhất.'))}
            {radio('wz-review', cur.review === 'light', () => setOpts((o) => ({ ...o, review: 'light' })), t('Chỉ hỏi bước quan trọng'), t('Các bước thường tự đi tiếp khi đủ kết quả; bạn vẫn duyệt bản dựng cuối.'))}
          </div>
        </fieldset>
      ) : null}

      {step === 3 ? (
        <fieldset className="wz-q">
          <legend>{t('Video của bạn cần những gì?')}</legend>
          <div className="wz-grid">
            {EXTRAS.map(([k, title, sub]) => (
              <label key={k} className={`wz-opt${cur[k] ? ' on' : ''}`}>
                <input type="checkbox" checked={!!cur[k]} onChange={(e) => setOpts((o) => ({ ...o, [k]: e.target.checked }))} disabled={busy} />
                <span><b>{tr(title)}</b><small>{tr(sub)}</small></span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      {step === 4 ? (
        <div className="wz-q">
          <h3>{t('Xem lại và đặt tên')}</h3>
          <span className="muted">
            {t('{n} bước', { n: steps.length })}{paid ? ` · ${t('{n} bước tốn tiền (luôn hỏi trước)', { n: paid })}` : ''}
          </span>
          <Flow steps={flowSteps(draft?.steps)} staticMode label={t('Các bước của {n}', { n: nameT })} />
          <label className="fld">
            <span className="fld-l">{t('Tên quy trình')}<Req /></span>
            <input type="text" required aria-required="true" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} disabled={busy} />
          </label>
          {err ? <div className="err-note" role="alert">{err}</div> : null}
        </div>
      ) : null}

      {sugg.error ? <div className="err-note" role="alert">{sugg.error.message}</div> : null}
      <div className="wz-acts">
        {step > 1 ? <button type="button" className="btn" onClick={() => setStep(step - 1)} disabled={busy}>{t('Quay lại')}</button> : <span />}
        {step < 4 ? (
          <button key="next" type="button" className="btn primary" onClick={() => setStep(step + 1)} disabled={!canNext}>{t('Tiếp')}</button>
        ) : (
          <button key="save" type="submit" className="btn primary" disabled={!canSave}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}{t('Lưu quy trình')}
          </button>
        )}
      </div>
    </form>
  );
}
