// Trang "Giọng đọc": chọn dịch vụ đọc văn bản thành tiếng (ElevenLabs có sẵn, API khác, hoặc lệnh trên máy). Khóa API chỉ lưu trên máy này.
import { Fragment, useCallback, useEffect, useState } from 'react';
import ConfirmModal from '../components/ConfirmModal.jsx';
import Modal from '../components/Modal.jsx';
import RowMenu from '../components/RowMenu.jsx';
import Select from '../components/Select.jsx';
import { langOf } from '../lib/langs.js';
import Req from '../components/Req.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../api.js';
import { useT } from '../lib/i18n.jsx';

const BLANK = {
  elevenlabs: { kind: 'elevenlabs', name: 'ElevenLabs', voice: '', model: 'eleven_multilingual_v2' },
  http: { kind: 'http', name: '', voice: '', http: { url: '', method: 'POST', headers: { Authorization: 'Bearer {key}' }, body: '{"text":"{text}","voice":"{voice}"}', response: 'audio', jsonPath: '' } },
  command: { kind: 'command', name: '', voice: '', command: '' },
  voicestudio: { kind: 'voicestudio', name: 'VoiceStudio', voice: 'male, middle-aged, moderate pitch', fx: { pitch: 0, tempo: 1, echo: 0, dark: false } },
};

// Nhãn loại dịch vụ hiện trên thẻ.
// Thuộc tính giọng VoiceStudio hiểu (mỗi nhóm chọn một); voice lưu dạng "male, middle-aged, low pitch".
const VS_ATTRS = [
  { key: 'gender', label: 'Giới tính', options: [['male', 'Nam'], ['female', 'Nữ']] },
  { key: 'age', label: 'Độ tuổi', options: [['child', 'Trẻ em (dưới 13 tuổi)'], ['teenager', 'Thiếu niên (13–19 tuổi)'], ['young adult', 'Thanh niên (20–35 tuổi)'], ['middle-aged', 'Trung niên (36–55 tuổi)'], ['elderly', 'Lớn tuổi (trên 55 tuổi)']] },
  { key: 'pitch', label: 'Độ cao giọng', options: [['very low pitch', 'Rất trầm'], ['low pitch', 'Trầm'], ['moderate pitch', 'Vừa'], ['high pitch', 'Cao'], ['very high pitch', 'Rất cao']] },
];
const vsParts = (voice = '') => {
  const tokens = voice.split(',').map((x) => x.trim().toLowerCase());
  const out = { whisper: tokens.includes('whisper') ? 'whisper' : '' };
  for (const a of VS_ATTRS) out[a.key] = a.options.map((o) => o[0]).find((o) => tokens.includes(o)) || '';
  return out;
};
const FX_SLIDERS = [['pitch', 'Trầm / cao', -6, 3, 0.5], ['tempo', 'Tốc độ', 0.7, 1.3, 0.05], ['echo', 'Vang', 0, 1, 0.05]];
const vsJoin = (o) => [o.gender, o.age, o.pitch, o.whisper].filter(Boolean).join(', ');
const KIND_LABEL = { elevenlabs: () => 'ElevenLabs', http: (t) => t('API tự định nghĩa'), command: (t) => t('Lệnh trên máy'), vieneu: (t) => t('Miễn phí, chạy trên máy'), voicestudio: (t) => t('VoiceStudio · miễn phí, chạy trên máy') };

function Editor({ init, vieneuVoices = [], vs = { available: true, voices: [] }, onClose, onSaved }) {
  const t = useT();
  const toast = useToast();
  const isNew = !init.id;
  const [p, setP] = useState(init);
  const [key, setKey] = useState('');
  const [price, setPrice] = useState(String(init.price?.perChar ?? (init.kind === 'elevenlabs' ? 1 : 0)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [voices, setVoices] = useState(null);
  const [bundled, setBundled] = useState(false);
  const [loadingV, setLoadingV] = useState(false);
  const [hidden, setHidden] = useState(0);
  const [sample, setSample] = useState(null);
  const [sampling, setSampling] = useState(false);
  const loadVoices = async () => {
    setLoadingV(true);
    setErr(null);
    try {
      const r = await api.ttsVoices({ id: init.id || null, key });
      setVoices(r.voices);
      setBundled(!!r.bundled);
      setHidden(r.hidden || 0);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setLoadingV(false);
    }
  };
  // Mở hộp thoại ElevenLabs → nạp sẵn danh sách gợi ý (không cần khóa).
  useEffect(() => {
    if (init.kind !== 'elevenlabs') return;
    if (init.hasKey) loadVoices(); // đã có khóa → hiện luôn giọng dùng được của tài khoản
    else api.ttsVoices({}).then((r) => { setVoices(r.voices); setBundled(!!r.bundled); }).catch(() => setVoices([]));
  }, [init.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const readSample = async () => {
    setSampling(true);
    setErr(null);
    setSample(null);
    try {
      setSample(await api.ttsSample({ id: init.id || null, key, voice: p.voice, kind: p.kind, fx: p.kind === 'voicestudio' ? p.fx : undefined }));
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setSampling(false);
    }
  };
  const picked = voices?.find((v) => v.id === p.voice);
  // Nhóm theo ngôn ngữ (tiếng Việt lên đầu), mỗi giọng có cờ nước của ngôn ngữ đó.
  const voiceOptions = [...(voices || [])]
    .map((v) => {
      const [code, ...rest] = String(v.desc || '').split(' · ');
      const l = langOf(code);
      return { l, o: { value: v.id, label: v.name, meta: (l.code ? rest : [code, ...rest]).filter(Boolean).join(' · ') || v.category, icon: l.flag, group: `${l.flag} ${l.known ? t(l.name) : l.name}` } };
    })
    .sort((x, y) => (y.l.code === 'vi') - (x.l.code === 'vi') || x.o.group.localeCompare(y.o.group))
    .map((x) => x.o);
  const fx = { pitch: 0, tempo: 1, echo: 0, dark: false, ...p.fx };
  const set = (patch) => {
    setErr(null);
    setP((x) => ({ ...x, ...patch }));
  };
  const setHttp = (patch) => setP((x) => ({ ...x, http: { ...x.http, ...patch } }));
  const hdr = Object.entries(p.http?.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.ttsSave({ provider: { ...p, price: p.kind === 'elevenlabs' ? { perChar: 1, label: 'credit' } : p.kind === 'vieneu' || p.kind === 'voicestudio' ? { perChar: 0, label: '' } : { perChar: Number(price) || 0, label: '' } }, key: key === '' ? undefined : key, makeDefault: isNew });
      toast(t('Đã lưu giọng đọc.'), 'ok');
      onSaved();
    } catch (e2) {
      setErr(e2.message);
      setBusy(false);
    }
  };
  return (
    <Modal title={isNew ? t('Thêm giọng đọc') : t('Sửa giọng đọc')} onClose={onClose} busy={busy} wide>
      <p className="lead">{p.kind === 'elevenlabs' ? t('Kết nối ElevenLabs để trợ lý đọc lời dẫn bằng giọng bạn chọn.') : p.kind === 'vieneu' ? t('Giọng tiếng Việt miễn phí chạy ngay trên máy — dùng khi chưa duyệt chi phí giọng trả phí.') : p.kind === 'voicestudio' ? t('Giọng đọc miễn phí, chạy trên máy.') : p.kind === 'http' ? t('Kết nối dịch vụ giọng đọc qua API HTTP.') : t('Kết nối công cụ giọng đọc chạy trên máy bạn.')}</p>
      <form onSubmit={save} noValidate>
        <label className="fld">
          <span className="fld-l">{t('Tên gọi')}<Req /></span>
          <input type="text" value={p.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} aria-label={t('Tên gọi')} disabled={busy} />
        </label>
        {p.kind === 'elevenlabs' ? (
          <ol className="tts-guide">
            <li>{t('Chọn giọng ở')} <a href="https://elevenlabs.io/app/voices" target="_blank" rel="noopener noreferrer">elevenlabs.io/app/voices</a>{t(', bấm dấu ba chấm (⋯) cạnh giọng → "Copy voice ID" rồi dán vào ô ID giọng.')}</li>
            <li>{t('Lấy khóa API ở')} <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener noreferrer">elevenlabs.io/app/settings/api-keys</a>{t(' → "Create API Key" (bật quyền Text to Speech) rồi dán vào ô Khóa API.')}</li>
          </ol>
        ) : null}
        {p.kind === 'http' ? (
          <>
            <p className="note">{t('Dùng được với dịch vụ có API trả về âm thanh. Trong địa chỉ, tiêu đề và thân có thể dùng {text} (văn bản), {voice} (giọng), {key} (khóa API).')}</p>
            <label className="fld">
              <span className="fld-l">{t('Địa chỉ API')}<Req /></span>
              <input type="text" value={p.http.url} onChange={(e) => setHttp({ url: e.target.value })} placeholder="https://api.example.com/v1/tts" aria-label={t('Địa chỉ API')} disabled={busy} />
            </label>
            <label className="fld">
              <span className="fld-l">{t('Tiêu đề (mỗi dòng một cái)')}</span>
              <textarea rows={3} value={hdr} onChange={(e) => setHttp({ headers: Object.fromEntries(e.target.value.split('\n').map((l) => l.split(/:\s*(.*)/s)).filter((a) => a[0]?.trim()).map((a) => [a[0].trim(), a[1] ?? ''])) })} aria-label={t('Tiêu đề')} disabled={busy} />
            </label>
            <label className="fld">
              <span className="fld-l">{t('Nội dung gửi đi (JSON)')}</span>
              <textarea rows={3} value={p.http.body} onChange={(e) => setHttp({ body: e.target.value })} aria-label={t('Nội dung gửi đi')} disabled={busy} />
            </label>
            <div className="fld">
              <span className="fld-l">{t('Dịch vụ trả về')}</span>
              <Select value={p.http.response} onChange={(v) => setHttp({ response: v })} disabled={busy} label={t('Dịch vụ trả về')} options={[
                { value: 'audio', label: t('File âm thanh trực tiếp') },
                { value: 'json-base64', label: t('JSON chứa âm thanh mã hóa base64') },
                { value: 'json-url', label: t('JSON chứa đường dẫn tải âm thanh') },
              ]} />
            </div>
            {p.http.response !== 'audio' ? (
              <label className="fld">
                <span className="fld-l">{t('Vị trí trong JSON')}</span>
                <input type="text" value={p.http.jsonPath} onChange={(e) => setHttp({ jsonPath: e.target.value })} placeholder="data.audio" aria-label={t('Vị trí trong JSON')} disabled={busy} />
              </label>
            ) : null}
          </>
        ) : null}
        {p.kind === 'command' ? (
          <label className="fld">
            <span className="fld-l">{t('Lệnh chạy')}<Req /></span>
            <input type="text" value={p.command} onChange={(e) => set({ command: e.target.value })} placeholder='my-tts --in {in} --out {out} --voice {voice}' aria-label={t('Lệnh chạy')} disabled={busy} />
            <span className="hint">{t('{in} = file văn bản, {out} = file âm thanh cần ghi, {voice} = giọng. Khóa API (nếu có) được truyền qua biến môi trường TTS_KEY.')}</span>
          </label>
        ) : null}
        {p.kind !== 'command' && p.kind !== 'vieneu' && p.kind !== 'voicestudio' ? (
          <label className="fld">
            <span className="fld-l">{t('Khóa API')}</span>
            <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} onBlur={() => { if (p.kind === 'elevenlabs' && key.trim()) loadVoices(); }} placeholder={init.hasKey ? t('Đã lưu — để trống để giữ nguyên') : ''} aria-label={t('Khóa API')} disabled={busy} />
            <span className="hint">{t('Khóa chỉ lưu trong Keychain/kho bí mật của máy này, không gửi cho Claude.')}</span>
          </label>
        ) : null}
        {p.kind === 'elevenlabs' ? (
          <div className="fld">
            <span className="fld-l">{t('Chọn giọng')}</span>
            <Select value={p.voice} onChange={(v) => set({ voice: v })} disabled={busy || !voices} label={t('Chọn giọng')} placeholder={voices ? t('Chọn giọng ({n})', { n: voices.length }) : t('Đang tải…')} options={voiceOptions} />
            {picked?.preview ? <audio className="tts-audio" controls src={picked.preview} /> : null}
            {p.voice && (key || init.hasKey) ? (
              <div className="tts-more">
                <button type="button" className="btn sm" onClick={readSample} data-ai="confirm" disabled={busy || sampling}>{sampling ? t('Đang đọc…') : t('Đọc thử một câu ngắn')}</button>
                <span className="hint">{t('Đọc câu "Xin chào, đây là giọng đọc thử." bằng giọng đã chọn — tốn khoảng 31 credit.')}</span>
                {sample ? <audio className="tts-audio" controls autoPlay src={sample.audio} /> : null}
              </div>
            ) : null}
            {bundled ? <span className="hint">{t('Đây là danh sách gợi ý. Giọng tiếng Việt thuộc thư viện cộng đồng: cần bấm "Add to my voices" trong tài khoản ElevenLabs của bạn (có thể cần gói trả phí) thì mới đọc được.')}</span> : <span className="hint">{hidden > 0 ? t('Chỉ hiện giọng dùng được với gói của bạn (đã ẩn {n} giọng thư viện cần gói trả phí).', { n: hidden }) : t('Giọng dùng được trong tài khoản ElevenLabs của bạn.')}</span>}
            {key || init.hasKey ? (
              <div className="tts-more">
                <button type="button" className="btn sm" onClick={() => loadVoices()} disabled={busy || loadingV}>{loadingV ? t('Đang tải…') : t('Tải lại danh sách giọng')}</button>
                <span className="hint">{t('Cần khóa có quyền "Voices: Read".')}</span>
              </div>
            ) : null}
          </div>
        ) : null}
        {p.kind === 'voicestudio' ? (
          <>
            {!vs.available ? <div className="err-note" role="alert">{t('Chưa cài app VoiceStudio.')} <a href="https://voicestudio.sh/" target="_blank" rel="noopener noreferrer">voicestudio.sh</a></div> : null}
            <div className="fld">
              <span className="fld-l">{t('Chủ đề')}</span>
              <Select value={(vs.themes || []).find((x) => x.voice === p.voice && JSON.stringify(x.fx) === JSON.stringify(p.fx))?.id || ''} onChange={(v) => { const th = (vs.themes || []).find((x) => x.id === v); if (th) set({ voice: th.voice, fx: th.fx }); }} disabled={busy} label={t('Chủ đề')} options={[{ value: '', label: t('Tùy chỉnh') }, ...(vs.themes || []).map((x) => ({ value: x.id, label: t(x.name) }))]} />
            </div>
            {VS_ATTRS.map((a) => (
              <div className="fld" key={a.key}>
                <span className="fld-l">{t(a.label)}</span>
                <Select value={vsParts(p.voice)[a.key]} onChange={(v) => set({ voice: vsJoin({ ...vsParts(p.voice), [a.key]: v }) })} disabled={busy} label={t(a.label)} options={[{ value: '', label: t('Tự động') }, ...a.options.map(([value, label]) => ({ value, label: t(label) }))]} />
              </div>
            ))}
            <div className="fld">
              <label className="chk">
                <input type="checkbox" checked={vsParts(p.voice).whisper === 'whisper'} disabled={busy} onChange={(e) => set({ voice: vsJoin({ ...vsParts(p.voice), whisper: e.target.checked ? 'whisper' : '' }) })} />
                <span>{t('Giọng thì thầm')}</span>
              </label>
            </div>
            {FX_SLIDERS.map(([k, label, min, max, step]) => (
              <div className="fld" key={k}>
                <span className="fld-l">{t(label)}</span>
                <input type="range" className="fx-range" min={min} max={max} step={step} value={fx[k]} disabled={busy} aria-label={t(label)} onChange={(e) => set({ fx: { ...fx, [k]: Number(e.target.value) } })} />
              </div>
            ))}
            <div className="fld">
              <label className="chk">
                <input type="checkbox" checked={fx.dark} disabled={busy} onChange={(e) => set({ fx: { ...fx, dark: e.target.checked } })} />
                <span>{t('Giọng ngột ngạt')}</span>
              </label>
              <div className="tts-more">
              <button type="button" className="btn sm" onClick={readSample} disabled={busy || sampling || !vs.available}>{sampling ? t('Đang đọc…') : t('Nghe thử giọng này')}</button>
              {sample ? <audio className="tts-audio" controls autoPlay src={sample.audio} /> : null}
            </div>
            </div>
          </>
        ) : null}
        {p.kind === 'vieneu' ? (
          <div className="fld">
            <span className="fld-l">{t('Chọn giọng')}</span>
            <Select value={p.voice} onChange={(v) => set({ voice: v })} disabled={busy} label={t('Chọn giọng')} options={vieneuVoices.map((v) => ({ value: v.id, label: v.name, meta: v.desc }))} />
          </div>
        ) : p.kind === 'voicestudio' ? null : (
          <label className="fld">
            <span className="fld-l">{p.kind === 'elevenlabs' ? t('ID giọng') : t('Giọng mặc định')}{p.kind === 'elevenlabs' ? <Req /> : null}</span>
            <input type="text" value={p.voice} onChange={(e) => set({ voice: e.target.value })} aria-label={t('Giọng')} disabled={busy} />
            {p.kind === 'elevenlabs' ? <span className="hint">{t('Tự điền khi bạn chọn giọng ở trên. Cũng có thể dán ID giọng khác.')}</span> : null}
          </label>
        )}
        {p.kind === 'voicestudio' ? (
          <p className="note tts-cost">{t('Miễn phí · đọc chậm, khoảng 3 phút cho 30 giây âm thanh.')}</p>
        ) : p.kind === 'vieneu' ? (
          <p className="note tts-cost">{t('Không tốn phí. Lần đầu chạy sẽ tải mô hình (vài trăm MB), các lần sau đọc nhanh.')}</p>
        ) : p.kind === 'elevenlabs' ? (
          <p className="note tts-cost">{t('Chi phí do ElevenLabs quy định: 1 credit cho mỗi ký tự đọc. Bước dùng giọng đọc luôn hỏi bạn duyệt chi phí trước khi chạy.')}</p>
        ) : (
          <label className="fld">
            <span className="fld-l">{t('Giá mỗi ký tự (0 = miễn phí)')}</span>
            <input type="text" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-label={t('Giá mỗi ký tự')} disabled={busy} />
            <span className="hint">{t('Nếu có giá, bước dùng giọng đọc sẽ chỉ chạy sau khi bạn bấm duyệt chi phí.')}</span>
          </label>
        )}
        {err ? <div className="err-note" role="alert">{err}</div> : null}
        <div className="modal-acts">
          <button type="submit" className="btn primary" disabled={busy}>{busy ? <><i className="spinner on-acc" aria-hidden="true" />{t('Đang lưu…')}</> : t('Lưu')}</button>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('Hủy')}</button>
        </div>
      </form>
    </Modal>
  );
}

// Cột quyền của khóa API: mỗi quyền một dòng có dấu ✓/✕/?.
function Perms({ i, onRetry }) {
  const t = useT();
  if (!i || i.busy) return <p className="note" role="status">{t('Đang kiểm tra quyền của khóa…')}</p>;
  if (i.error) return <div className="tts-perms"><p className="note">{i.error}</p><button type="button" className="btn sm" onClick={onRetry}>{t('Kiểm tra lại')}</button></div>;
  if (!i.valid) return <span className="sel-badge bad">{t('Khóa không hợp lệ hoặc đã bị thu hồi')}</span>;
  const rows = [
    [i.perms.tts, t('Text to Speech')],
    [i.perms.voices, t('Đọc danh sách giọng')],
    [i.perms.user, t('Xem gói và credit')],
  ];
  return (
    <ul className="tts-perms">
      {rows.map(([v, label]) => (
        <li key={label} className={v === 'yes' ? 'ok' : v === 'no' ? 'bad' : ''}>
          <i aria-hidden="true">{v === 'yes' ? '✓' : v === 'no' ? '✕' : '?'}</i>
          <span>{label}</span>
          <span className="sr-only">{v === 'yes' ? t('có') : v === 'no' ? t('thiếu') : t('chưa rõ')}</span>
        </li>
      ))}
    </ul>
  );
}

// Cột gói & chi phí: gói, credit còn lại (nếu khóa xem được), giá mỗi ký tự.
function Plan({ p, i }) {
  const t = useT();
  const left = i?.credits?.limit ? Math.max(0, i.credits.limit - i.credits.used) : null;
  const used = left !== null ? i.credits.limit - left : 0;
  const pct = left !== null ? Math.round((used / i.credits.limit) * 100) : 0; // thanh = phần đã dùng
  const price = p.price?.perChar > 0 ? `${p.price.perChar} ${p.price.label || ''}/${t('ký tự')}` : t('miễn phí');
  return (
    <dl className="tts-kv">
      {i?.tier ? <><dt>{t('Gói')}</dt><dd>{i.tier}</dd></> : null}
      {left !== null ? (
        <>
          <dt>{t('Credit còn')}</dt>
          <dd>
            {left.toLocaleString()} / {i.credits.limit.toLocaleString()}
            <div className={`quota-bar q-${pct < 70 ? 'ok' : pct < 90 ? 'wait' : 'err'}`} role="progressbar" aria-label={t('Credit đã dùng')} aria-valuemin={0} aria-valuemax={i.credits.limit} aria-valuenow={used}>
              <span style={{ width: `${pct}%` }} />
            </div>
          </dd>
        </>
      ) : null}
      <dt>{t('Chi phí')}</dt><dd>{price}</dd>
      {p.kind === 'elevenlabs' && i?.valid && i.perms.user !== 'yes' ? <dd className="hint tts-kv-wide">{t('Khóa chưa có quyền User (Read) nên không xem được gói và credit — vẫn đọc bình thường.')}</dd> : null}
    </dl>
  );
}

export default function TTS() {
  const t = useT();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [edit, setEdit] = useState(null);
  const [kindPick, setKindPick] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [text, setText] = useState('');
  const [testing, setTesting] = useState(null);
  const [prog, setProg] = useState(0);
  const [progInfo, setProgInfo] = useState('');
  const [audio, setAudio] = useState(null);
  const [info, setInfo] = useState({});
  const load = useCallback(() => {
    api.tts().then((d) => { setData(d); setErr(null); }).catch((e) => setErr(e.message));
  }, []);
  useEffect(load, [load]);
  // Kiểm tra quyền của khóa ElevenLabs (không tốn credit) mỗi khi danh sách đổi.
  const checkKey = useCallback((id) => {
    setInfo((m) => ({ ...m, [id]: { busy: true } }));
    api.ttsCheck({ id }).then((r) => setInfo((m) => ({ ...m, [id]: r })), (e) => setInfo((m) => ({ ...m, [id]: { error: e.message } })));
  }, []);
  useEffect(() => {
    for (const p of data?.providers || []) if (p.kind === 'elevenlabs' && p.hasKey && !info[p.id]) checkKey(p.id);
  }, [data, info, checkKey]);
  const act = async (fn, msg) => {
    try {
      setData(await fn());
      if (msg) toast(msg, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  const test = async (id) => {
    setTesting(id);
    setAudio(null);
    setProg(0);
    try {
      let j = await api.ttsTest({ id, text: text.trim() || undefined });
      while (j.state === 'running') {
        await new Promise((r) => setTimeout(r, 1000));
        j = await api.ttsTestJob(j.job);
        setProg(j.progress || 0);
        setProgInfo(j.parts > 1 ? t('Đoạn {a}/{b}', { a: Math.min(j.part + 1, j.parts), b: j.parts }) : '');
      }
      if (j.state === 'error') throw new Error(j.error);
      const r = j.result;
      setAudio({ id, src: r.audio, chars: r.chars, cost: r.cost, label: r.label, paid: r.paid, cached: r.cached });
      if (data?.providers?.find((x) => x.id === r.provider)?.kind === 'vieneu') setData((d) => (d ? { ...d, vieneuWarm: true } : d));
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setTesting(null);
    }
  };
  const list = data?.providers || [];
  return (
    <>
      <div className="page-h" data-ai-help="tts">
        <h1>{t('Giọng đọc')}</h1>
        <div className="sk-acts">
          <button type="button" className="btn sm primary" onClick={() => setKindPick(true)}>{t('Thêm giọng đọc')}</button>
        </div>
      </div>
      <p className="note tts-intro">{t('Chọn dịch vụ biến văn bản thành giọng nói. Khi một bước cần lồng tiếng, trợ lý sẽ dùng giọng mặc định ở đây — khóa API không bao giờ đi qua Claude.')}</p>
      {err ? <div className="err-note" role="alert">{err}</div> : null}
      {!data && !err ? <p className="note" role="status">{t('Đang tải…')}</p> : null}
      {data && !list.length ? (
        <div className="card pad empty">
          <b>{t('Chưa có giọng đọc nào.')}</b>
          <p className="note">{t('Bấm "Thêm giọng đọc" để dùng ElevenLabs hoặc dịch vụ khác của bạn.')}</p>
        </div>
      ) : null}
      {list.length ? (
        <>
          <label className="fld">
            <span className="fld-l">{t('Câu đọc thử (để trống dùng câu mẫu)')}</span>
            <textarea rows={3} value={text} maxLength={3000} onChange={(e) => setText(e.target.value)} aria-label={t('Câu đọc thử')} />
            <span className="hint">{t('Giọng miễn phí đọc được tối đa 3.000 ký tự; giọng trả phí chỉ 300 ký tự đầu.')}</span>
          </label>
          <div className="sk-tbl-wrap tts-tbl-wrap">
            <table className="sk-tbl tts-tbl">
              <thead>
                <tr>
                  <th scope="col" className="tts-c-name">{t('Dịch vụ')}</th>
                  <th scope="col">{t('Quyền của khóa')}</th>
                  <th scope="col">{t('Gói & chi phí')}</th>
                  <th scope="col" className="tts-c-act"><span className="sr-only">{t('Hành động')}</span></th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <Fragment key={p.id}>
                    <tr className={audio?.id === p.id ? 'has-play' : undefined}>
                      <th scope="row" className="tts-c-name">
                        <div><b>{p.builtin ? t(p.name) : p.name}</b> {data.default === p.id ? <span className="sel-badge ok">{t('Mặc định')}</span> : null}</div>
                        <p className="note">
                          {(KIND_LABEL[p.kind] || KIND_LABEL.command)(t)}
                          {p.kind === 'elevenlabs' || p.kind === 'http' ? ` · ${p.hasKey ? (p.keyHint ? t('khóa …{k}', { k: p.keyHint }) : t('đã có khóa')) : t('chưa có khóa')}` : ''}
                        </p>
                      </th>
                      <td>
                        {p.kind === 'elevenlabs' && p.hasKey ? <Perms i={info[p.id]} onRetry={() => checkKey(p.id)} />
                          : <p className="note">{p.kind === 'elevenlabs' ? t('Chưa có khóa') : p.kind === 'vieneu' || p.kind === 'voicestudio' ? t('Không cần khóa') : t('Không áp dụng')}</p>}
                      </td>
                      <td><Plan p={p} i={info[p.id]} /></td>
                      <td className="tts-c-act">
                        <RowMenu
                          label={t('Thao tác với giọng đọc {n}', { n: p.name })}
                          items={[
                            { label: testing !== p.id ? t('Đọc thử') : p.kind === 'vieneu' && !data.vieneuWarm ? t('Đang nạp giọng… (~7 giây)') : p.kind === 'voicestudio' ? t('Đang đọc… (xem thanh tiến độ bên dưới)') : t('Đang đọc…'), onClick: () => test(p.id), disabled: testing === p.id, ai: p.kind === 'elevenlabs' || p.price?.perChar > 0 ? 'confirm' : undefined },
                            ...(data.default !== p.id ? [{ label: t('Đặt mặc định'), onClick: () => act(() => api.ttsDefault(p.id)) }] : []),
                            { label: t('Sửa'), onClick: () => setEdit(p) },
                            ...(p.builtin ? [] : [{ sep: true }, { label: t('Xóa'), onClick: () => setRemoving(p), danger: true }]),
                          ]}
                        />
                      </td>
                    </tr>
                    {testing === p.id ? (
                      <tr className="tts-play-row">
                        <td colSpan={4}>
                          <div className="tts-play" role="progressbar" aria-valuenow={Math.round(prog * 100)} aria-valuemin={0} aria-valuemax={100}>
                            <div className="bar"><i style={{ width: `${Math.round(prog * 100)}%` }} /></div>
                            <p className="note">{t('Đang tạo âm thanh… {n}%', { n: Math.round(prog * 100) })}{progInfo ? ` · ${progInfo}` : ''}</p>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                    {audio?.id === p.id ? (
                      <tr className="tts-play-row">
                        <td colSpan={4}>
                          <div className="tts-play">
                            <audio controls autoPlay src={audio.src} />
                            {audio.paid ? <p className="note">{audio.cached ? t('Câu này đã đọc trước đó — phát lại, không tốn thêm {l}.', { l: audio.label || 'credit' }) : t('Đã dùng khoảng {n} {l}.', { n: audio.cost, l: audio.label || '' })}</p> : null}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {kindPick ? (
        <Modal title={t('Bạn muốn dùng dịch vụ nào?')} onClose={() => setKindPick(false)}>
          <div className="sk-steps tts-kinds">
            <button type="button" className="btn" onClick={() => { setKindPick(false); setEdit(BLANK.elevenlabs); }}>ElevenLabs</button>
            <button type="button" className="btn" onClick={() => { setKindPick(false); setEdit(BLANK.voicestudio); }}>{t('VoiceStudio (miễn phí, chạy trên máy)')}</button>
            <button type="button" className="btn" onClick={() => { setKindPick(false); setEdit(BLANK.http); }}>{t('Dịch vụ khác có API (nâng cao)')}</button>
            <button type="button" className="btn" onClick={() => { setKindPick(false); setEdit(BLANK.command); }}>{t('Lệnh có sẵn trên máy (nâng cao)')}</button>
          </div>
        </Modal>
      ) : null}
      {removing ? (
        <ConfirmModal
          title={t('Xóa giọng đọc "{n}"?', { n: removing.name })}
          body={removing.hasKey ? t('Giọng đọc này và khóa API đã lưu sẽ bị xóa khỏi máy. Muốn dùng lại phải thêm và nhập khóa lại.') : t('Giọng đọc này sẽ bị xóa khỏi máy.')}
          okLabel={t('Xóa')}
          danger
          onOk={async () => {
            setData(await api.ttsRemove(removing.id));
            toast(t('Đã xóa.'), 'ok');
          }}
          onClose={() => setRemoving(null)}
        />
      ) : null}
      {edit ? <Editor key={edit.id || edit.kind} init={edit} vieneuVoices={data?.vieneuVoices} vs={data?.voicestudio} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} /> : null}
    </>
  );
}
