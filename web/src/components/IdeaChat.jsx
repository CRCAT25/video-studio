// Chat nhỏ trong hộp "Dự án mới": trợ lý hỏi nhu cầu, gợi ý ý tưởng hợp kênh + đề xuất bố cục các bước. Không lưu lịch sử.
import { useRef, useState } from 'react';
import { api } from '../api.js';
import { useT } from '../lib/i18n.jsx';

// channelId: kênh đang chọn; onUseIdea(title): điền tiêu đề; onApplySteps(ids): áp bố cục; stepName(id): tên hiển thị.
export default function IdeaChat({ channelId, onUseIdea, onApplySteps, stepName, disabled = false }) {
  const t = useT();
  const [msgs, setMsgs] = useState([]); // {role:'user'|'assistant', text, ideas?, steps?}
  const [text, setText] = useState('');
  const [web, setWeb] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [used, setUsed] = useState(''); // ý tưởng/bố cục vừa áp (để đánh dấu)
  const endRef = useRef(null);

  const send = async (raw) => {
    const q = String(raw ?? text).trim();
    if (!q || busy) return;
    const next = [...msgs, { role: 'user', text: q }];
    setMsgs(next);
    setText('');
    setErr('');
    setBusy(true);
    try {
      const r = await api.ideasChat({ channelId: channelId || '', web, messages: next.map((m) => ({ role: m.role, text: m.text })) });
      setMsgs([...next, { role: 'assistant', text: r.reply, ideas: r.ideas || [], steps: r.steps || [] }]);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
      setTimeout(() => endRef.current?.scrollIntoView?.({ block: 'nearest' }), 0);
    }
  };
  const starters = [t('Gợi ý ý tưởng hợp với kênh'), t('Tôi muốn làm về chủ đề…'), t('Đề xuất bố cục các bước')];

  return (
    <div className="idea-chat" data-ai-region="idea-chat">
      {msgs.length ? (
        <div className="ic-log" aria-live="polite">
          {msgs.map((m, i) => (
            <div key={i} className={`ic-msg ${m.role}`}>
              <p>{m.text}</p>
              {m.ideas?.length ? (
                <ul className="ic-ideas">
                  {m.ideas.map((d, j) => (
                    <li key={j} className="ic-idea">
                      <b>{d.title}</b>
                      {d.why ? <span className="hint">{d.why}</span> : null}
                      {d.viral ? <span className="hint">🔥 {d.viral}</span> : null}
                      <button type="button" className={`btn sm${used === d.title ? ' primary' : ''}`} disabled={disabled} onClick={() => { onUseIdea(d.title); setUsed(d.title); }}>
                        {used === d.title ? t('Đã dùng') : t('Dùng ý tưởng này')}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {m.steps?.length ? (
                <div className="ic-idea">
                  <b>{t('Bố cục đề xuất')}</b>
                  <span className="hint">{m.steps.map((id, k) => `${k + 1}. ${stepName(id)}`).join(' → ')}</span>
                  <button type="button" className={`btn sm${used === `s${i}` ? ' primary' : ''}`} disabled={disabled} onClick={() => { onApplySteps(m.steps); setUsed(`s${i}`); }}>
                    {used === `s${i}` ? t('Đã áp dụng') : t('Áp dụng')}
                  </button>
                </div>
              ) : null}
            </div>
          ))}
          {busy ? <div className="ic-msg assistant"><span className="spinner" aria-hidden="true" /> {t('Trợ lý đang nghĩ…')}</div> : null}
          <div ref={endRef} />
        </div>
      ) : (
        <div className="ic-start">
          {starters.map((s) => (
            <button key={s} type="button" className="chip" disabled={disabled || busy} onClick={() => (s.endsWith('…') ? setText(s.slice(0, -1) + ' ') : send(s))}>{s}</button>
          ))}
        </div>
      )}
      {err ? <div className="err-note" role="alert">{err}</div> : null}
      {/* không dùng <form>: chat nằm trong form của hộp "Dự án mới" */}
      <div className="ic-form">
        <input type="text" value={text} maxLength={600} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }} placeholder={t('Nhắn cho trợ lý — vd: ngân sách thấp, muốn video ngắn…')} disabled={disabled || busy} aria-label={t('Nhắn cho trợ lý')} />
        <button type="button" className="btn primary" disabled={disabled || busy || !text.trim()} onClick={() => send()}>{t('Gửi')}</button>
      </div>
      <label className="chk">
        <input type="checkbox" checked={web} onChange={(e) => setWeb(e.target.checked)} disabled={disabled || busy} />
        <span>{t('Tìm xu hướng trên web')} <span className="muted">· {t('chậm và tốn token hơn')}</span></span>
      </label>
    </div>
  );
}
