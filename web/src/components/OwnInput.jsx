// Khung "Tôi có sẵn / Để Claude làm" ở trang bước: người dùng tự thêm file (kéo thả/chọn/dán chữ) rồi dùng nguyên hoặc nhờ Claude hoàn thiện; hoặc chọn cách Claude làm.
import { useRef, useState } from 'react';
import { api } from '../api.js';
import { fmtBytes } from '../lib/format.js';
import { useT } from '../lib/i18n.jsx';

// info = kết quả api.stepOwn; src = 'own' | 'claude'; method = id cách làm (null = Claude tự chọn).
export default function OwnInput({ projectId, stepKey, info, src, onSrc, method, onMethod, onChanged, disabled, busy, paid, canDone, canRun, onUseAsIs, onRefine }) {
  const t = useT();
  const [work, setWork] = useState(null); // 'up' | 'text' | path đang gỡ
  const [upName, setUpName] = useState('');
  const [text, setText] = useState('');
  const [drag, setDrag] = useState(false);
  const [err, setErr] = useState(null);
  const input = useRef(null);
  const files = info.files || [];
  const locked = disabled || !!work;

  const pick = (m) => !disabled && onSrc(m);
  const key = (m) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(m);
    }
  };

  // Tải lần lượt từng file; file lỗi thì báo và dừng ở đó.
  const upload = async (list) => {
    const arr = [...(list || [])];
    if (!arr.length || locked) return;
    setErr(null);
    setWork('up');
    try {
      for (const f of arr) {
        setUpName(f.name);
        await api.uploadOwn(projectId, stepKey, f);
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setWork(null);
      setUpName('');
      if (input.current) input.current.value = '';
      onChanged();
    }
  };
  const saveText = async () => {
    if (!text.trim() || locked) return;
    setErr(null);
    setWork('text');
    try {
      await api.pasteOwn(projectId, stepKey, text);
      setText('');
    } catch (e) {
      setErr(e.message);
    } finally {
      setWork(null);
      onChanged();
    }
  };
  const remove = async (p) => {
    setErr(null);
    setWork(p);
    try {
      await api.removeOwn(projectId, stepKey, p);
    } catch (e) {
      setErr(e.message);
    } finally {
      setWork(null);
      onChanged();
    }
  };
  const onDrop = (e) => {
    e.preventDefault();
    setDrag(false);
    upload(e.dataTransfer?.files);
  };

  const accept = info.accept.map((x) => `.${x}`).join(',');
  return (
    <section className="voice-pick own-pick" aria-label={t('Nguồn nội dung của bước')} data-ai-help="own-pick">
      <p className="vp-what">
        <b>{t('Bạn có sẵn nội dung cho bước này?')}</b> {t('Tự thêm file của bạn, hoặc để Claude làm.')}
      </p>
      <div className="vp-cards" role="radiogroup" aria-label={t('Nguồn nội dung')}>
        <div role="radio" tabIndex={0} aria-checked={src === 'own'} aria-disabled={disabled} className={`fmt-card vp-card${src === 'own' ? ' on' : ''}`} onClick={() => pick('own')} onKeyDown={key('own')}>
          <b>{t('Tôi có sẵn')}</b>
          <span>{t('Thêm kịch bản, giọng, hình hay video của bạn')}</span>
        </div>
        <div role="radio" tabIndex={0} aria-checked={src === 'claude'} aria-disabled={disabled} className={`fmt-card vp-card${src === 'claude' ? ' on' : ''}`} onClick={() => pick('claude')} onKeyDown={key('claude')}>
          <b>{t('Để Claude làm')}</b>
          <span>{info.methods.length ? t('Chọn cách làm bên dưới rồi bấm Chạy') : t('Bấm Chạy, Claude làm từ đầu')}</span>
        </div>
      </div>

      {src === 'own' ? (
        <div className="own-body">
          <div
            className={`own-drop${drag ? ' on' : ''}`}
            onDragOver={(e) => (e.preventDefault(), !locked && setDrag(true))}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
          >
            <span>{work === 'up' ? t('Đang tải {n}…', { n: upName }) : t('Kéo thả file vào đây hoặc')}</span>
            <button type="button" className="btn sm" onClick={() => input.current?.click()} disabled={locked}>
              {work === 'up' ? <span className="spinner" aria-hidden="true" /> : null}
              {t('Chọn file')}
            </button>
            <input ref={input} className="sr-only" type="file" multiple accept={accept} tabIndex={-1} aria-hidden="true" onChange={(e) => upload(e.target.files)} />
            <span className="note">{t('Nhận: {x}', { x: info.accept.join(', ') })}</span>
          </div>
          {info.text ? (
            <div className="own-text">
              <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Hoặc dán nội dung {f} vào đây…', { f: info.text })} disabled={locked} aria-label={t('Dán nội dung')} />
              <button type="button" className="btn sm" onClick={saveText} disabled={locked || !text.trim()}>
                {work === 'text' ? <span className="spinner" aria-hidden="true" /> : null}
                {t('Lưu')}
              </button>
            </div>
          ) : null}
          {files.length ? (
            <ul className="own-files">
              {files.map((f) => (
                <li key={f.path}>
                  <code>{f.path}</code>
                  <span className="note">{fmtBytes(f.size)}</span>
                  <button type="button" className="btn sm" onClick={() => remove(f.path)} disabled={locked}>
                    {work === f.path ? <span className="spinner" aria-hidden="true" /> : null}
                    {t('Gỡ')}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {files.length ? (
            <div className="vp-foot">
              <button type="button" className="btn primary" onClick={onUseAsIs} disabled={locked || !!busy || !canDone} title={canDone ? '' : t('Các bước trước phải xong trước')}>
                {busy === 'complete' ? <span className="spinner" aria-hidden="true" /> : null}
                {t('Dùng nguyên, xong bước')}
              </button>
              <button type="button" className={`btn${paid ? ' paid' : ''}`} onClick={onRefine} disabled={locked || !!busy || !canRun}>
                {busy === 'run' ? <span className="spinner" aria-hidden="true" /> : null}
                {paid ? '$ ' : ''}
                {t('Để Claude hoàn thiện từ file của tôi')}
              </button>
            </div>
          ) : null}
        </div>
      ) : info.methods.length ? (
        <div className="own-body">
          <div className="chips" role="radiogroup" aria-label={t('Cách làm')}>
            {[{ id: null, label: t('Claude tự chọn') }, ...info.methods.map((m) => ({ id: m.id, label: t(m.label) }))].map((m) => (
              <button key={m.id || 'auto'} type="button" role="radio" aria-checked={method === m.id} className={`chip${method === m.id ? ' on' : ''}`} onClick={() => onMethod(m.id)} disabled={disabled}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {err ? <p className="err-note">{err}</p> : null}
    </section>
  );
}
