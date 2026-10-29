// Trang Bộ não: cây ghi nhớ dùng chung giữa bạn, trợ lý và các bước video (brain.md).
// Xem dung lượng, duyệt đề xuất, sửa/xóa từng mục, nén khi đầy, khôi phục bản sao lưu.
import { useCallback, useEffect, useState } from 'react';
import Modal from '../components/Modal.jsx';
import ConfirmModal from '../components/ConfirmModal.jsx';
import Select from '../components/Select.jsx';
import Progress from '../components/Progress.jsx';
import Req from '../components/Req.jsx';
import { BranchIcon } from '../components/icons.jsx';
import { Sk, SkZone } from '../components/Skeleton.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../api.js';
import { useT } from '../lib/i18n.jsx';
import { fmtBytes, fmtDateTime } from '../lib/format.js';
import { HINTS, hint, setHintOverrides } from '../lib/aiHints.js';
import BrainMap from './BrainMap.jsx';

const NESTED = new Set(['Kênh', 'Bước làm video']);
const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;

// Nhãn nguồn của một mục (ai đã đưa vào bộ não).
function srcLabel(src, t) {
  return { user: t('Bạn'), assistant: t('Trợ lý'), step: t('Bước video'), feedback: t('Góp ý 👎'), style: t('Phong cách'), compact: t('Bản nén') }[src] || src;
}

// Tên gốc của cây theo ngôn ngữ đang chọn (khóa vẫn là tên tiếng Việt trong brain.md).
function rootLabel(r, t) {
  return { Chung: t('Chung'), 'Phong cách': t('Phong cách'), 'Cách dùng app': t('Cách dùng app'), Kênh: t('Kênh'), 'Bước làm video': t('Bước làm video'), 'Bài học': t('Bài học'), 'Chưa phân loại': t('Chưa phân loại') }[r] || r;
}

// Nhãn loại thay đổi trong lịch sử.
function kindLabel(kind, t) {
  return { add: t('Thêm mục'), edit: t('Sửa mục'), delete: t('Xóa mục'), compact: t('Nén'), restore: t('Khôi phục'), style: t('Phong cách') }[kind] || kind;
}

// Tách "Kênh/goc-kham-pha" → {root, sub}.
function splitPath(p) {
  const i = p.indexOf('/');
  return i < 0 ? { root: p, sub: '' } : { root: p.slice(0, i), sub: p.slice(i + 1) };
}

// Hộp thêm/sửa một ghi nhớ (dùng cả cho "Sửa rồi nhận" đề xuất): chọn nhánh + nội dung.
function ItemModal({ title, okLabel, roots, init, onSave, onClose }) {
  const t = useT();
  const start = splitPath(init?.branch || 'Chung');
  const [root, setRoot] = useState(start.root);
  const [sub, setSub] = useState(start.sub);
  const [text, setText] = useState(init?.text || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const nested = NESTED.has(root);
  const subOk = !nested || SLUG.test(sub.trim());
  const ok = text.trim() && subOk;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSave({ branch: nested ? `${root}/${sub.trim()}` : root, text: text.trim() });
      onClose();
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose} busy={busy}>
      <div className="fld">
        <span className="fld-l">{t('Nhánh')}</span>
        <Select label={t('Nhánh')} value={root} onChange={setRoot} disabled={busy} options={roots.map((r) => ({ value: r, label: rootLabel(r, t) }))} />
      </div>
      {nested ? (
        <label className="fld">
          <span>{root === 'Kênh' ? t('Mã kênh') : t('Mã bước')}<Req /></span>
          <input value={sub} onChange={(e) => setSub(e.target.value.toLowerCase())} disabled={busy} placeholder={root === 'Kênh' ? 'goc-kham-pha' : 'kich-ban'} spellCheck={false} />
          <span className="hint">{t('Chữ thường không dấu, số và dấu gạch ngang.')}</span>
        </label>
      ) : null}
      <label className="fld">
        <span>{t('Nội dung')}<Req /></span>
        <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} data-autofocus />
        <span className="hint">{t('Mỗi mục một ý, viết ngắn và rõ.')}</span>
      </label>
      {err ? <div className="err-note" role="alert">{err}</div> : null}
      <div className="modal-acts">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('Hủy')}</button>
        <button type="button" className="btn primary" onClick={save} disabled={busy || !ok}>{okLabel}</button>
      </div>
    </Modal>
  );
}

// Hộp sửa 1 mục kiến thức gốc: nội dung trợ lý đọc ở vùng màn hình đó; Lưu bản trùng gốc = về mặc định.
function HintModal({ id, max, onSave, onClose }) {
  const t = useT();
  const h = hint(id);
  const [text, setText] = useState(h.text);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ok = text.trim() && text.trim().length <= max;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSave(text.trim());
      onClose();
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Sửa kiến thức gốc')} onClose={onClose} busy={busy}>
      <label className="fld">
        <span>{h.title}<Req /></span>
        <textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} maxLength={max} data-autofocus />
        <span className="hint">{t('Trợ lý đọc mục này khi vùng đó hiện trên màn hình. Viết ngắn, đúng tên nút thật. {n}/{max} ký tự.', { n: text.trim().length, max })}</span>
      </label>
      {err ? <div className="err-note" role="alert">{err}</div> : null}
      <div className="modal-acts">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('Hủy')}</button>
        <button type="button" className="btn primary" onClick={save} disabled={busy || !ok}>{t('Lưu')}</button>
      </div>
    </Modal>
  );
}

// Hộp nén: gọi Claude (effort max) soạn bản gọn, cho xem trước rồi mới áp dụng.
function CompactModal({ onClose, onDone }) {
  const t = useT();
  const toast = useToast();
  const [stage, setStage] = useState('ask'); // ask | run | review
  const [pv, setPv] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setStage('run');
    setErr(null);
    try {
      setPv(await api.brainCompact());
      setStage('review');
    } catch (e) {
      setErr(e.message);
      setStage('ask');
    }
  };
  const apply = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.brainApply(pv.id);
      toast(t('Đã nén bộ não — bản cũ được sao lưu.'), 'ok');
      onDone();
      onClose();
    } catch (e) {
      // 409: bộ não đổi trong lúc xem → phải nén lại; 404: bản nháp hết hạn.
      setErr(e.message);
      if (e.status === 409 || e.status === 404) setStage('ask');
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Nén bộ não')} onClose={onClose} busy={busy || stage === 'run'} wide>
      {stage === 'ask' ? <p>{t('Claude (mức suy nghĩ cao nhất) sẽ gộp mục trùng, bỏ mục lỗi thời và viết gọn lại. Bước này tốn token của gói Claude; bạn xem trước bản nén rồi mới quyết định áp dụng.')}</p> : null}
      {stage === 'run' ? <Progress label={t('Claude đang nén bộ não…')} /> : null}
      {stage === 'review' && pv ? (
        <>
          <p className="note">
            {t('Từ {a} còn {b}.', { a: fmtBytes(pv.before), b: fmtBytes(pv.after) })} {pv.summary}
          </p>
          <div className="br-preview">
            {pv.branches.map((b) => (
              <div key={b.path}>
                <b>{b.path}</b>
                <ul>
                  {b.items.map((it) => (
                    <li key={it.id}>{it.text}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {err ? <div className="err-note" role="alert">{err}</div> : null}
      <div className="modal-acts">
        <button type="button" className="btn" onClick={onClose} disabled={busy || stage === 'run'}>{t('Hủy')}</button>
        {stage === 'review' ? (
          <button type="button" className="btn primary" onClick={apply} disabled={busy}>{t('Áp dụng')}</button>
        ) : (
          <button type="button" className="btn primary" onClick={run} disabled={stage === 'run'}>{t('Bắt đầu nén')}</button>
        )}
      </div>
    </Modal>
  );
}

// Một mục trong cây: nội dung + nguồn/ngày + Sửa/Xóa.
function Item({ it, onEdit, onDelete }) {
  const t = useT();
  return (
    <li className="br-item">
      <div className="br-text">{it.text}</div>
      <div className="br-meta">
        <span className="muted">{srcLabel(it.src, t)}{it.at ? ` · ${it.at}` : ''}{it.from ? ` · ${it.from}` : ''}</span>
        <span className="br-acts">
          <button type="button" className="btn sm ghost" onClick={() => onEdit(it)}>{t('Sửa')}</button>
          <button type="button" className="btn sm ghost" onClick={() => onDelete(it)}>{t('Xóa')}</button>
        </span>
      </div>
    </li>
  );
}

// Một gốc của cây: các mục trực tiếp, và (Kênh / Bước làm video) các nhánh con.
function RootNode({ root, branches, readers, onEdit, onDelete, onAdd }) {
  const t = useT();
  const own = branches.filter((b) => b.path === root);
  const subs = branches.filter((b) => b.path.startsWith(`${root}/`));
  const count = [...own, ...subs].reduce((n, b) => n + b.items.length, 0);
  return (
    <div className={`br-node-w${onAdd ? ' can-add' : ''}${count ? '' : ' is-empty'}`}>
    <details className="br-node card" open={count > 0}>
      <summary>
        <BranchIcon name={ROOT_ICONS[root]} />
        <b>{rootLabel(root, t)}</b>
        <span className="muted">· {t('{n} mục', { n: count })}</span>
        <Readers ast={readers.assistant.includes(root)} step={readers.step.includes(root)} />
      </summary>
      {!count ? <p className="note">{t('Chưa có ghi nhớ nào ở nhánh này.')}</p> : null}
      {own.map((b) => (
        <ul key={b.path} className="br-items">
          {b.items.map((it) => <Item key={it.id} it={{ ...it, branch: b.path }} onEdit={onEdit} onDelete={onDelete} />)}
        </ul>
      ))}
      {subs.map((b) => (
        <div key={b.path} className="br-sub">
          <div className="br-sub-h mono">{splitPath(b.path).sub} <span className="muted">· {b.items.length}</span></div>
          <ul className="br-items">
            {b.items.map((it) => <Item key={it.id} it={{ ...it, branch: b.path }} onEdit={onEdit} onDelete={onDelete} />)}
          </ul>
        </div>
      ))}
    </details>
    {onAdd ? <button type="button" className="btn sm ghost br-add" onClick={() => onAdd(root)} aria-label={t('Thêm vào {b}', { b: rootLabel(root, t) })}>{t('+ Thêm')}</button> : null}
    </div>
  );
}

// Biểu tượng của từng gốc (gốc lạ dùng hộp chung).
const ROOT_ICONS = { Chung: 'pin', 'Phong cách': 'palette', 'Cách dùng app': 'app', Kênh: 'video', 'Bước làm video': 'film', 'Bài học': 'book', 'Chưa phân loại': 'inbox' };

// Nhãn quyền đọc: ai được đọc nhánh này.
function Readers({ ast, step }) {
  const t = useT();
  if (!ast && !step) return null;
  return (
    <span className="br-who">
      {ast ? <span className="tag r-ast">{t('Trợ lý')}</span> : null}
      {step ? <span className="tag r-step">{t('Bước video')}</span> : null}
    </span>
  );
}

// Kiểu xem đã chọn lần trước (mặc định là cây).
function readView() {
  try { return localStorage.getItem('vs-brain-view') === 'map' ? 'map' : 'tree'; } catch { return 'tree'; }
}

// rev: App tăng mỗi khi server báo bộ não đổi (SSE 'brain') → trang tải lại.
export default function Brain({ rev = 0 }) {
  const t = useT();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [modal, setModal] = useState(null); // {kind:'add'|'edit'|'accept'|'hint', ...}
  const [confirm, setConfirm] = useState(null); // {title, body, okLabel, danger, onOk}
  const [compact, setCompact] = useState(false);
  const [view, setView] = useState(readView); // 'tree' | 'map', nhớ theo trình duyệt
  const mapLabel = useCallback((r) => rootLabel(r, t), [t]);

  // Đổi kiểu xem Cây/Sơ đồ và nhớ lại cho lần sau.
  const pickView = (v) => {
    setView(v);
    try { localStorage.setItem('vs-brain-view', v); } catch { /* trình duyệt chặn lưu thì thôi */ }
  };

  const [hintMax, setHintMax] = useState(600);
  const [hintRev, setHintRev] = useState(0);
  const [hintOpen, setHintOpen] = useState(null);
  const load = useCallback(() => {
    api.brain().then((d) => { setData(d); setErr(null); }).catch((e) => setErr(e));
    api.hints().then((d) => { setHintOverrides(d.overrides); setHintMax(d.max); setHintRev((n) => n + 1); }, () => {});
  }, []);
  const saveHint = async (id, text) => {
    const d = await api.saveHint(id, text);
    setHintOverrides(d.overrides);
    setHintRev((n) => n + 1);
  };
  useEffect(load, [load, rev]);

  const act = async (fn, msg) => {
    try {
      await fn();
      if (msg) toast(msg, 'ok');
      load();
    } catch (e) {
      toast(e.message, 'err');
    }
  };

  const pct = data ? Math.min(100, (data.bytes / data.max) * 100) : 0;
  const bar = data ? { ok: 'q-ok', warn: 'q-wait', full: 'q-err' }[data.level] : 'q-ok';
  const hints = Object.keys(HINTS).map(hint);
  const edited = hints.filter((h) => h.custom).length;

  return (
    <>
      <div className="page-h" data-ai-help="brain">
        <div>
          <h1>{t('Bộ não')}</h1>
          <p className="note">{t('Những điều app đã học về bạn: sở thích, quy tắc, bài học. Trợ lý và các bước video đọc bộ não trước khi làm; mục mới chỉ vào khi bạn duyệt.')}</p>
        </div>
        <div className="br-top-acts">
          <div className="seg" role="radiogroup" aria-label={t('Kiểu xem')}>
            {[['tree', t('Cây')], ['map', t('Sơ đồ')]].map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={view === v} className={view === v ? 'on' : ''} onClick={() => pickView(v)}>{l}</button>
            ))}
          </div>
          <button type="button" className="btn sm" onClick={load}>{t('Tải lại')}</button>
          <button type="button" className="btn sm" onClick={() => setCompact(true)} disabled={!data?.items}>{t('Nén')}</button>
          <button type="button" className="btn sm primary" onClick={() => setModal({ kind: 'add' })} disabled={!data || data.level === 'full'}>{t('+ Thêm ghi nhớ')}</button>
        </div>
      </div>
      {err ? <div className="err-note" role="alert">{t('Không tải được bộ não:')} {err.message}</div> : null}
      {!data && !err ? (
        <SkZone className="bp-list" label={t('Đang tải bộ não')}>
          <div className="card pad"><Sk w="12em" /><Sk w="24em" /></div>
        </SkZone>
      ) : null}
      {data ? (
        <div className="br-page">
          <section className="card pad br-stats">
            <div className="br-cap">
              <b>{t('Dung lượng')}</b>
              <span className="muted">{fmtBytes(data.bytes)} / {fmtBytes(data.max)} · {t('{n} ghi nhớ', { n: data.items })}</span>
            </div>
            <div className={`quota-bar br-bar ${bar}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={t('Dung lượng bộ não')}>
              <span style={{ width: `${pct}%` }} />
            </div>
            {data.level === 'warn' ? <p className="note">{t('Bộ não sắp đầy — nên bấm "Nén" để gọn lại.')}</p> : null}
            {data.level === 'full' ? <div className="err-note" role="alert">{t('Bộ não đã đầy: không nhận thêm ghi nhớ cho tới khi bạn nén hoặc xóa bớt.')}</div> : null}
            {Object.keys(data.bySrc).length ? (
              <div className="br-chips">
                {Object.entries(data.bySrc).map(([s, n]) => (
                  <span key={s} className="chip">{srcLabel(s, t)}<span className="n">{n}</span></span>
                ))}
              </div>
            ) : null}
            <p className="hint">
              {t('Trợ lý đọc: {a}. Các bước video đọc: {b}.', { a: data.readers.assistant.map((r) => rootLabel(r, t)).join(', '), b: data.readers.step.map((r) => rootLabel(r, t)).join(', ') })}
            </p>
          </section>

          {data.proposals.length ? (
            <section className="card pad br-props" aria-label={t('Chờ duyệt')}>
              <h2 className="sec-h">{t('Chờ duyệt')} <span className="badge">{data.proposals.length}</span></h2>
              <ul className="br-items">
                {data.proposals.map((p) => (
                  <li key={p.id} className="br-item">
                    <div className="br-text">{p.text}</div>
                    <div className="br-meta">
                      <span className="muted">{rootLabel(splitPath(p.branch).root, t)}{splitPath(p.branch).sub ? `/${splitPath(p.branch).sub}` : ''} · {srcLabel(p.src, t)}{p.reason ? ` · ${p.reason}` : ''}</span>
                      <span className="br-acts">
                        <button type="button" className="btn sm primary" onClick={() => act(() => api.brainAccept(p.id), t('Đã nhận vào bộ não.'))}>{t('Nhận')}</button>
                        <button type="button" className="btn sm" onClick={() => setModal({ kind: 'accept', id: p.id, init: { branch: p.branch, text: p.text } })}>{t('Sửa rồi nhận')}</button>
                        <button type="button" className="btn sm ghost" onClick={() => act(() => api.brainReject(p.id))}>{t('Bỏ')}</button>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {view === 'map' ? (
            <BrainMap data={data} rootLabel={mapLabel} onEdit={(it) => setModal({ kind: 'edit', id: it.id, init: { branch: it.branch, text: it.text } })} />
          ) : (
          <section className="br-tree" aria-label={t('Cây ghi nhớ')}>
            {data.roots.map((r) => (
              <RootNode
                key={r}
                root={r}
                branches={data.branches}
                readers={data.readers}
                onAdd={data.level === 'full' ? null : (b) => setModal({ kind: 'add', init: { branch: b, text: '' } })}
                onEdit={(it) => setModal({ kind: 'edit', id: it.id, init: { branch: it.branch, text: it.text } })}
                onDelete={(it) => setConfirm({ title: t('Xóa ghi nhớ?'), body: it.text, okLabel: t('Xóa'), danger: true, onOk: async () => { await api.brainRemove(it.id); load(); } })}
              />
            ))}
            <div className="br-node-w">
            <details className="br-node card">
              <summary>
                <BranchIcon name="bulb" />
                <b>{t('Kiến thức gốc')}</b>
                <span className="muted">· {t('{n} mục', { n: hints.length })}{edited ? ` · ${t('{n} đã sửa', { n: edited })}` : ''} · {t('theo màn đang mở')}</span>
                <Readers ast />
              </summary>
              <ul className="br-items">
                {Object.keys(HINTS).map((id, i) => (
                  <li key={id} className={`br-item br-hint${hintOpen === id ? ' open' : ''}`}>
                    <div className="br-hint-row">
                      <button type="button" className="br-hint-t" aria-expanded={hintOpen === id} onClick={() => setHintOpen(hintOpen === id ? null : id)}>
                        <b>{hints[i].title}</b>
                        <span className="muted">{hints[i].text}</span>
                      </button>
                      {hints[i].custom ? <span className="tag r-ast">{t('Bạn đã sửa')}</span> : null}
                      <button type="button" className="btn sm ghost" onClick={() => setModal({ kind: 'hint', id })}>{t('Sửa')}</button>
                    </div>
                    {hintOpen === id ? (
                      <div className="br-hint-body">
                        <div className="br-text">{hints[i].text}</div>
                        {hints[i].custom ? (
                          <div className="br-meta">
                            <button type="button" className="btn sm ghost" onClick={() => setConfirm({ title: t('Khôi phục mặc định?'), body: HINTS[id].text, okLabel: t('Khôi phục'), onOk: async () => { await saveHint(id, ''); toast(t('Đã về nội dung mặc định.'), 'ok'); } })}>{t('Khôi phục mặc định')}</button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
            </div>
          </section>
          )}

          <details className="card pad bp-more br-log">
            <summary>{t('Lịch sử thay đổi ({n})', { n: data.history.length })}</summary>
            {data.history.length ? (
              <ul className="br-hist">
                {[...data.history].reverse().slice(0, 60).map((h, i) => (
                  <li key={`${h.at}-${i}`}>
                    <span className="muted mono">{fmtDateTime(h.at)}</span> <b>{kindLabel(h.kind, t)}</b> {h.note}
                  </li>
                ))}
              </ul>
            ) : <p className="note">{t('Chưa có thay đổi nào.')}</p>}
          </details>

          <details className="card pad bp-more br-log">
            <summary>{t('Bản sao lưu ({n})', { n: data.backups.length })}</summary>
            {data.backups.length ? (
              <ul className="br-hist">
                {data.backups.map((b) => (
                  <li key={b.name} className="br-bk">
                    <span><span className="muted mono">{fmtDateTime(b.at)}</span> {b.reason ? kindLabel(b.reason, t) : ''} · {fmtBytes(b.bytes)}</span>
                    <button type="button" className="btn sm" onClick={() => setConfirm({ title: t('Khôi phục bản sao lưu?'), body: t('Bộ não hiện tại sẽ được sao lưu trước, rồi thay bằng bản lúc {d}.', { d: fmtDateTime(b.at) }), okLabel: t('Khôi phục'), onOk: async () => { await api.brainRestore(b.name); toast(t('Đã khôi phục bộ não.'), 'ok'); load(); } })}>{t('Khôi phục')}</button>
                  </li>
                ))}
              </ul>
            ) : <p className="note">{t('Chưa có bản sao lưu — app tự sao lưu trước mỗi lần nén hoặc khôi phục.')}</p>}
            <p className="hint mono">{data.file}</p>
          </details>
        </div>
      ) : null}

      {modal?.kind === 'add' ? (
        <ItemModal title={t('Thêm ghi nhớ')} okLabel={t('Lưu')} roots={data.roots} init={modal.init} onClose={() => setModal(null)} onSave={async (b) => { await api.brainAdd(b.branch, b.text); toast(t('Đã thêm vào bộ não.'), 'ok'); load(); }} />
      ) : null}
      {modal?.kind === 'edit' ? (
        <ItemModal title={t('Sửa ghi nhớ')} okLabel={t('Lưu')} roots={data.roots} init={modal.init} onClose={() => setModal(null)} onSave={async (b) => { await api.brainEdit(modal.id, b); load(); }} />
      ) : null}
      {modal?.kind === 'accept' ? (
        <ItemModal title={t('Sửa rồi nhận')} okLabel={t('Nhận')} roots={data.roots} init={modal.init} onClose={() => setModal(null)} onSave={async (b) => { await api.brainAccept(modal.id, b); toast(t('Đã nhận vào bộ não.'), 'ok'); load(); }} />
      ) : null}
      {modal?.kind === 'hint' ? (
        <HintModal id={modal.id} max={hintMax} onClose={() => setModal(null)} onSave={async (text) => { await saveHint(modal.id, text); toast(t('Đã lưu kiến thức gốc.'), 'ok'); }} />
      ) : null}
      {confirm ? <ConfirmModal {...confirm} onClose={() => setConfirm(null)} /> : null}
      {compact ? <CompactModal onClose={() => setCompact(false)} onDone={load} /> : null}
    </>
  );
}
