// Khung chọn giọng ở bước có phương án miễn phí (vd. Giọng đọc): giải thích bước làm gì, chọn giọng miễn phí hay trả phí, chi phí ước tính.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { fmtNum } from '../lib/format.js';
import { useT } from '../lib/i18n.jsx';

const CHARS_PER_SEC = 15; // tốc độ đọc tiếng Việt ước chừng

// Số credit/tiền ước tính của giọng trả phí cho số ký tự sẽ đọc (null nếu chưa biết).
export function paidEstimate(info) {
  if (!info?.paid || info.chars == null) return null;
  return Math.round(info.chars * (info.paid.perChar || 0));
}

// info = kết quả api.stepVoice; mode = 'free' | 'paid'; onMode đổi lựa chọn.
export default function VoicePicker({ info, mode, onMode, disabled = false }) {
  const t = useT();
  const [playing, setPlaying] = useState(null); // 'free' | 'paid' | 'load-free'
  const [err, setErr] = useState(null);
  const audio = useRef(null);
  useEffect(() => () => audio.current?.pause(), []);

  const stop = () => {
    audio.current?.pause();
    audio.current = null;
    setPlaying(null);
  };
  // Nghe thử: VieNeu đọc 1 câu trên máy (miễn phí); ElevenLabs phát file mẫu có sẵn (không tốn credit).
  const listen = async (which) => {
    if (playing === which) return stop();
    stop();
    setErr(null);
    let src = info[which]?.preview;
    if (which === 'free') {
      setPlaying('load-free');
      try {
        src = (await api.ttsTest({ id: info.free.id })).audio;
      } catch (e) {
        setPlaying(null);
        setErr(e.message);
        return;
      }
    }
    if (!src) return setPlaying(null);
    const a = new Audio(src);
    audio.current = a;
    a.onended = () => setPlaying(null);
    setPlaying(which);
    a.play().catch((e) => {
      setPlaying(null);
      setErr(t('Không phát được âm thanh: {m}', { m: e.message }));
    });
  };

  const mins = info.chars ? Math.max(1, Math.round(info.chars / CHARS_PER_SEC / 60)) : null;
  const est = paidEstimate(info);
  const paidOk = !!info.paid && info.paid.hasKey;
  const pick = (m) => !disabled && (m === 'free' || paidOk) && onMode(m);
  const key = (m) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(m);
    }
  };
  const listenBtn = (which) => (
    <button type="button" className="btn sm" onClick={(e) => (e.stopPropagation(), listen(which))} disabled={playing === 'load-free'}>
      {playing === 'load-free' && which === 'free' ? <span className="spinner" aria-hidden="true" /> : null}
      {playing === which ? t('■ Dừng') : t('▶ Nghe thử')}
    </button>
  );

  return (
    <section className="voice-pick" aria-label={t('Chọn giọng đọc')}>
      <p className="vp-what">
        <b>{t('Bước này làm gì?')}</b>{' '}
        {t('Đọc lời thoại trong {f}', { f: info.source || t('kịch bản') })}
        {info.chars != null ? ` (${t('{n} ký tự, khoảng {m} phút', { n: fmtNum(info.chars), m: mins })})` : ''}
        {' → '}
        {t('tạo file giọng')}
        {info.next ? ` → ${t('bước "{n}" ráp vào phim câm', { n: t(info.next.name) })}` : ''}.
      </p>
      <div className="vp-cards" role="radiogroup" aria-label={t('Chọn giọng')}>
        <div role="radio" tabIndex={0} aria-checked={mode === 'free'} aria-disabled={disabled} className={`fmt-card vp-card${mode === 'free' ? ' on' : ''}`} onClick={() => pick('free')} onKeyDown={key('free')}>
          <b>{t('Miễn phí')}</b>
          <span>{info.free ? `VieNeu · ${t('giọng {v}', { v: info.free.voiceName || info.free.voice })}` : 'VieNeu'}</span>
          <ul>
            <li>{t('Chạy ngay trên máy, 0 đồng')}</li>
            <li>{t('Chậm hơn, giọng hơi máy')}</li>
          </ul>
          <div className="vp-foot">
            {info.free ? listenBtn('free') : null}
            <a href="#/tts" onClick={(e) => e.stopPropagation()}>{t('Đổi giọng')}</a>
          </div>
        </div>
        <div role="radio" tabIndex={paidOk ? 0 : -1} aria-checked={mode === 'paid'} aria-disabled={disabled || !paidOk} className={`fmt-card vp-card${mode === 'paid' ? ' on' : ''}${paidOk ? '' : ' off'}`} onClick={() => pick('paid')} onKeyDown={key('paid')}>
          <b>{info.paid ? t('{n} (trả phí)', { n: info.paid.name }) : t('Giọng trả phí')}</b>
          {info.paid ? <span>{t('giọng {v}', { v: info.paid.voiceName || info.paid.voice })}</span> : null}
          {info.paid ? (
            <ul>
              <li>{t('Tự nhiên, nhiều cảm xúc hơn')}</li>
              <li className="vp-cost">{est != null ? t('Tốn khoảng {n} {u}', { n: fmtNum(est), u: info.paid.label || '' }) : t('Chưa ước tính được chi phí')}</li>
            </ul>
          ) : (
            <p className="note">{t('Chưa thêm giọng trả phí.')}</p>
          )}
          <div className="vp-foot">
            {info.paid?.hasKey && info.paid.preview ? listenBtn('paid') : null}
            {info.paid && !info.paid.hasKey ? <span className="note">{t('Chưa nhập khóa API.')}</span> : null}
            <a href="#/tts" onClick={(e) => e.stopPropagation()}>{info.paid ? t('Đổi giọng') : t('Thêm giọng')}</a>
          </div>
        </div>
      </div>
      {err ? <p className="err-note">{err}</p> : null}
    </section>
  );
}
