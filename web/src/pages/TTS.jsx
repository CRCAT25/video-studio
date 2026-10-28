// Trang "Giọng đọc": chọn dịch vụ đọc văn bản thành tiếng (ElevenLabs có sẵn, API khác, hoặc lệnh trên máy). Khóa API chỉ lưu trên máy này.
import { useCallback, useEffect, useState } from 'react';
import Modal from '../components/Modal.jsx';
import Select from '../components/Select.jsx';
import Req from '../components/Req.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../api.js';
import { useT } from '../lib/i18n.jsx';

const BLANK = {
  elevenlabs: { kind: 'elevenlabs', name: 'ElevenLabs', voice: '', model: 'eleven_multilingual_v2' },
  http: { kind: 'http', name: '', voice: '', http: { url: '', method: 'POST', headers: { Authorization: 'Bearer {key}' }, body: '{"text":"{text}","voice":"{voice}"}', response: 'audio', jsonPath: '' } },
  command: { kind: 'command', name: '', voice: '', command: '' },
};

function Editor({ init, onClose, onSaved }) {
  const t = useT();
  const toast = useToast();
  const isNew = !init.id;
  const [p, setP] = useState(init);
  const [key, setKey] = useState('');
  const [price, setPrice] = useState(String(init.price?.perChar ?? (init.kind === 'elevenlabs' ? 1 : 0)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (patch) => setP((x) => ({ ...x, ...patch }));
  const setHttp = (patch) => setP((x) => ({ ...x, http: { ...x.http, ...patch } }));
  const hdr = Object.entries(p.http?.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.ttsSave({ provider: { ...p, price: { perChar: Number(price) || 0, label: p.kind === 'elevenlabs' ? 'credit' : '' } }, key: key === '' ? undefined : key, makeDefault: isNew });
      toast(t('Đã lưu giọng đọc.'), 'ok');
      onSaved();
    } catch (e2) {
      setErr(e2.message);
      setBusy(false);
    }
  };
  return (
    <Modal title={isNew ? t('Thêm giọng đọc') : t('Sửa giọng đọc')} onClose={onClose} busy={busy} wide>
      <form onSubmit={save} noValidate>
        <label className="fld">
          <span className="fld-l">{t('Tên gọi')}<Req /></span>
          <input type="text" value={p.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} aria-label={t('Tên gọi')} disabled={busy} />
        </label>
        {p.kind === 'elevenlabs' ? (
          <ol className="note" style={{ paddingLeft: 20, margin: '0 0 16px' }}>
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
        <label className="fld">
          <span className="fld-l">{p.kind === 'elevenlabs' ? t('ID giọng') : t('Giọng mặc định')}{p.kind === 'elevenlabs' ? <Req /> : null}</span>
          <input type="text" value={p.voice} onChange={(e) => set({ voice: e.target.value })} aria-label={t('Giọng')} disabled={busy} />
        </label>
        {p.kind !== 'command' ? (
          <label className="fld">
            <span className="fld-l">{t('Khóa API')}</span>
            <input type="password" style={{ width: '100%', height: 36 }} autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={init.hasKey ? t('Đã lưu — để trống để giữ nguyên') : ''} aria-label={t('Khóa API')} disabled={busy} />
            <span className="hint">{t('Khóa chỉ lưu trong Keychain/kho bí mật của máy này, không gửi cho Claude.')}</span>
          </label>
        ) : null}
        <label className="fld">
          <span className="fld-l">{p.kind === 'elevenlabs' ? t('Giá mỗi ký tự (credit)') : t('Giá mỗi ký tự (0 = miễn phí)')}</span>
          <input type="text" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-label={t('Giá mỗi ký tự')} disabled={busy} />
          <span className="hint">{t('Nếu có giá, bước dùng giọng đọc sẽ chỉ chạy sau khi bạn bấm duyệt chi phí.')}</span>
        </label>
        {err ? <div className="err-note" role="alert">{err}</div> : null}
        <div className="row" style={{ gap: 8 }}>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? <><i className="spinner on-acc" aria-hidden="true" />{t('Đang lưu…')}</> : t('Lưu')}</button>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('Hủy')}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function TTS() {
  const t = useT();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [edit, setEdit] = useState(null);
  const [kindPick, setKindPick] = useState(false);
  const [text, setText] = useState('');
  const [testing, setTesting] = useState(null);
  const [audio, setAudio] = useState(null);
  const load = useCallback(() => {
    api.tts().then((d) => { setData(d); setErr(null); }).catch((e) => setErr(e.message));
  }, []);
  useEffect(load, [load]);
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
    try {
      const r = await api.ttsTest({ id, text: text.trim() || undefined });
      setAudio({ id, src: r.audio, chars: r.chars, cost: r.cost, label: r.label, paid: r.paid });
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setTesting(null);
    }
  };
  const list = data?.providers || [];
  return (
    <>
      <div className="page-h">
        <h1>{t('Giọng đọc')}</h1>
        <div className="sk-acts">
          <button type="button" className="btn sm primary" onClick={() => setKindPick(true)}>{t('Thêm giọng đọc')}</button>
        </div>
      </div>
      <p className="note">{t('Chọn dịch vụ biến văn bản thành giọng nói. Khi một bước cần lồng tiếng, Claude sẽ dùng giọng mặc định ở đây — khóa API không bao giờ đi qua Claude.')}</p>
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
            <input type="text" value={text} maxLength={300} onChange={(e) => setText(e.target.value)} aria-label={t('Câu đọc thử')} />
          </label>
          {list.map((p) => (
            <div key={p.id} className="card pad" style={{ marginBottom: 12 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <b>{p.name}</b> {data.default === p.id ? <span className="sel-badge ok">{t('Mặc định')}</span> : null}
                  <p className="note">
                    {p.kind === 'elevenlabs' ? 'ElevenLabs' : p.kind === 'http' ? t('API tự định nghĩa') : t('Lệnh trên máy')}
                    {p.kind !== 'command' ? ` · ${p.hasKey ? t('đã có khóa') : t('chưa có khóa')}` : ''}
                    {p.price?.perChar > 0 ? ` · ${p.price.perChar} ${p.price.label || ''}/${t('ký tự')}` : ` · ${t('miễn phí')}`}
                  </p>
                </div>
                <div className="sk-acts">
                  <button type="button" className="btn sm" disabled={testing === p.id} onClick={() => test(p.id)}>{testing === p.id ? t('Đang đọc…') : t('Đọc thử')}</button>
                  {data.default !== p.id ? <button type="button" className="btn sm" onClick={() => act(() => api.ttsDefault(p.id))}>{t('Đặt mặc định')}</button> : null}
                  <button type="button" className="btn sm" onClick={() => setEdit(p)}>{t('Sửa')}</button>
                  <button type="button" className="btn sm" onClick={() => { if (window.confirm(t('Xóa giọng đọc này (và khóa API đã lưu)?'))) act(() => api.ttsRemove(p.id), t('Đã xóa.')); }}>{t('Xóa')}</button>
                </div>
              </div>
              {audio?.id === p.id ? (
                <div style={{ marginTop: 10 }}>
                  <audio controls autoPlay src={audio.src} style={{ width: '100%' }} />
                  {audio.paid ? <p className="note">{t('Đã dùng khoảng {n} {l}.', { n: audio.cost, l: audio.label || '' })}</p> : null}
                </div>
              ) : null}
            </div>
          ))}
        </>
      ) : null}
      {kindPick ? (
        <Modal title={t('Bạn muốn dùng dịch vụ nào?')} onClose={() => setKindPick(false)}>
          <div className="sk-steps" style={{ paddingLeft: 0 }}>
            <button type="button" className="btn" onClick={() => { setKindPick(false); setEdit(BLANK.elevenlabs); }}>ElevenLabs</button>
            <button type="button" className="btn" onClick={() => { setKindPick(false); setEdit(BLANK.http); }}>{t('Dịch vụ khác có API (nâng cao)')}</button>
            <button type="button" className="btn" onClick={() => { setKindPick(false); setEdit(BLANK.command); }}>{t('Lệnh có sẵn trên máy (nâng cao)')}</button>
          </div>
        </Modal>
      ) : null}
      {edit ? <Editor key={edit.id || edit.kind} init={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} /> : null}
    </>
  );
}
