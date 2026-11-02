// Hỏi trợ lý về một bước (chỉ đọc, không tạo lượt chạy) — để hiểu kết quả mà khỏi chạy lại tốn token.
import { useState } from 'react';
import { api } from '../api.js';
import { useT } from '../lib/i18n.jsx';

export default function AskStep({ projectId, stepKey, disabled = false, onRerun = null }) {
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
      setLog((l) => [...l, { q: question, a: r.answer, rerun: r.rerunFeedback || '', watched: r.watched?.title || '' }]);
    } catch (e) {
      setErr(e.message);
      setText(question);
    } finally {
      setPending('');
      setBusy(false);
    }
  }

  const starters = [t('Ổn rồi'), t('Chưa ổn, vì sao lại như vậy?'), t('Hình ảnh đã thay đổi gì so với lượt trước?')];

  return (
    <div className="idea-chat" data-ai-region="ask-step">
      <div className="ic-log" aria-live="polite">
        <div className="ic-msg assistant">{t('Kết quả đầu ra của bước này ổn chứ? Nếu chưa ổn, cứ nói chỗ nào chưa ưng — muốn làm lại thì nói "làm lại", mình sẽ chỉ chạy lại khi bạn yêu cầu.')}</div>
          {log.map((m, i) => (
            <div key={i}>
              <div className="ic-msg user">{m.q}</div>
              {m.watched ? <div className="ic-msg assistant hint">{t('Đã xem video: {title}', { title: m.watched })}</div> : null}
              <div className="ic-msg assistant">{m.a}</div>
              {m.rerun && onRerun && i === log.length - 1 ? (
                <div className="ic-msg assistant">
                  <button type="button" className="btn primary" disabled={disabled || busy} onClick={() => onRerun(m.rerun)}>{t('Chạy lại với góp ý này')}</button>
                </div>
              ) : null}
            </div>
          ))}
          {pending ? <div className="ic-msg user">{pending}</div> : null}
          {busy ? <div className="ic-msg assistant"><span className="spinner" aria-hidden="true" /> {/youtu\.?be/.test(pending) ? t('Trợ lý đang xem video (khoảng 1 phút)…') : t('Trợ lý đang xem…')}</div> : null}
      </div>
      {log.length || pending ? null : (
        <div className="ic-start">
          {starters.map((s) => (
            <button key={s} type="button" className="chip" disabled={disabled || busy} onClick={() => send(s)}>{s}</button>
          ))}
        </div>
      )}
      {err ? <div className="err-note" role="alert">{err}</div> : null}
      <div className="ic-form">
        <input type="text" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }} placeholder={t('Trả lời trợ lý…')} aria-label={t('Trả lời trợ lý…')} disabled={disabled || busy} />
        <button type="button" className="btn primary" disabled={disabled || busy || !text.trim()} onClick={() => send()}>{t('Gửi')}</button>
      </div>
      <span className="hint">{t('Trò chuyện chỉ đọc kết quả, rất ít token. Bước chỉ chạy lại khi bạn yêu cầu và bấm xác nhận.')}</span>
    </div>
  );
}
