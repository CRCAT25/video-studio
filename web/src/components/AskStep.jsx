// Hỏi trợ lý về một bước (chỉ đọc, không tạo lượt chạy) — để hiểu kết quả mà khỏi chạy lại tốn token.
import { useState } from 'react';
import { api } from '../api.js';
import { useT } from '../lib/i18n.jsx';

export default function AskStep({ projectId, stepKey, disabled = false }) {
  const t = useT();
  const [log, setLog] = useState([]); // [{q, a}]
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [pending, setPending] = useState('');

  async function send(q = text) {
    const question = q.trim();
    if (!question || busy) return;
    setBusy(true);
    setErr(null);
    setPending(question);
    setText('');
    try {
      const r = await api.askStep(projectId, stepKey, question, log.slice(-4));
      setLog((l) => [...l, { q: question, a: r.answer }]);
    } catch (e) {
      setErr(e.message);
      setText(question);
    } finally {
      setPending('');
      setBusy(false);
    }
  }

  const starters = [t('Vì sao kết quả bước này như vậy?'), t('Hình ảnh đã thay đổi gì so với lượt trước?'), t('Nên góp ý gì để lượt sau tốt hơn?')];

  return (
    <div className="idea-chat" data-ai-region="ask-step">
      {log.length || pending ? (
        <div className="ic-log" aria-live="polite">
          {log.map((m, i) => (
            <div key={i}>
              <div className="ic-msg user">{m.q}</div>
              <div className="ic-msg assistant">{m.a}</div>
            </div>
          ))}
          {pending ? <div className="ic-msg user">{pending}</div> : null}
          {busy ? <div className="ic-msg assistant"><span className="spinner" aria-hidden="true" /> {t('Trợ lý đang xem…')}</div> : null}
        </div>
      ) : (
        <div className="ic-start">
          {starters.map((s) => (
            <button key={s} type="button" className="chip" disabled={disabled || busy} onClick={() => send(s)}>{s}</button>
          ))}
        </div>
      )}
      {err ? <div className="err-note" role="alert">{err}</div> : null}
      <div className="ic-form">
        <input type="text" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }} placeholder={t('Hỏi về bước này…')} aria-label={t('Hỏi về bước này…')} disabled={disabled || busy} />
        <button type="button" className="btn primary" disabled={disabled || busy || !text.trim()} onClick={() => send()}>{t('Hỏi')}</button>
      </div>
      <span className="hint">{t('Chỉ đọc kết quả đã có, không chạy lại bước và không sửa file — tốn rất ít token so với một lượt chạy.')}</span>
    </div>
  );
}
