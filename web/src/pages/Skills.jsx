// Trang Skills: thư viện skill của app (~/.video-studio/skills). Xem/sửa SKILL.md, nhập từ máy / dán nội dung / GitHub, xóa.
import { useCallback, useEffect, useState } from 'react';
import Modal from '../components/Modal.jsx';
import { Sk, SkZone } from '../components/Skeleton.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../api.js';
import Select from '../components/Select.jsx';
import Req from '../components/Req.jsx';
import { useT } from '../lib/i18n.jsx';
import SkillRepo from './SkillRepo.jsx';

// Trình xem/sửa SKILL.md; đóng khi có thay đổi chưa lưu thì hỏi lại một lần.
function SkillEditor({ name, onClose, onSaved }) {
  const t = useT();
  const toast = useToast();
  const [doc, setDoc] = useState(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [askClose, setAskClose] = useState(false);
  useEffect(() => {
    api.skill(name).then((d) => { setDoc(d); setText(d.content); }).catch((e) => setErr(e.message));
  }, [name]);

  const dirty = doc != null && text !== doc.content;
  const close = () => (dirty && !askClose ? setAskClose(true) : onClose());
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const d = await api.saveSkill(name, text);
      setDoc(d);
      setText(d.content);
      toast(t('Đã lưu skill "{n}".', { n: name }), 'ok');
      onSaved();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={name} lead={doc ? undefined : t('Đang tải…')} onClose={close} wide busy={busy}>
      {doc?.usedBy?.length ? <p className="note">{t('Đang được dùng bởi quy trình: {n}', { n: doc.usedBy.map((u) => u.name).join(', ') })}</p> : null}
      {doc ? (
        <label className="fld">
          <span>{t('Nội dung SKILL.md')}<Req /></span>
          <textarea className="mono-in" rows={18} value={text} onChange={(e) => { setText(e.target.value); setAskClose(false); }} spellCheck={false} data-autofocus />
          {doc.files.length ? <span className="hint">{t('File kèm theo: {n}', { n: doc.files.slice(0, 8).join(', ') + (doc.files.length > 8 ? '…' : '') })}</span> : null}
          <span className="hint mono">{doc.path}</span>
        </label>
      ) : null}
      {askClose ? <div className="err-note" role="alert">{t('Còn thay đổi chưa lưu — bấm "Đóng" lần nữa để bỏ.')}</div> : null}
      {err ? <div className="err-note" role="alert">{err}</div> : null}
      <div className="modal-acts">
        <button type="button" className="btn" onClick={close} disabled={busy}>{t('Đóng')}</button>
        <button type="button" className="btn primary" onClick={save} disabled={busy || !dirty}>{t('Lưu')}</button>
      </div>
    </Modal>
  );
}

const WARN = 'Skill là chỉ dẫn mà Claude sẽ làm theo khi chạy bước — chỉ nhập skill từ nguồn bạn tin cậy, và nên xem nội dung trước khi dùng.';

// Chọn skill (checkbox) từ một danh sách {name,title,description,imported?}.
function PickList({ items, picked, setPicked }) {
  const t = useT();
  return (
    <div className="sk-pick">
      {items.map((s) => (
        <label key={s.name} className="chk">
          <input type="checkbox" checked={picked.has(s.name)} onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(s.name); else n.delete(s.name); return n; })} />
          <span>
            <b>{s.name}</b>{s.imported ? <span className="muted"> · {t('đã có trong thư viện')}</span> : null}
            {s.description ? <span className="hint">{s.description}</span> : null}
          </span>
        </label>
      ))}
    </div>
  );
}

// Hộp thoại nhập skill: 3 nguồn (từ máy, dán nội dung, GitHub).
// initial? = {tab:'github', url} hoặc {tab:'local', names:[...]} khi mở từ gợi ý của tìm kiếm AI (vẫn phải bấm Nhập).
function ImportModal({ initial = null, onClose, onDone }) {
  const t = useT();
  const toast = useToast();
  const [tab, setTab] = useState(initial?.tab || 'local');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [rename, setRename] = useState(false);
  const [local, setLocal] = useState(null);
  const [picked, setPicked] = useState(new Set(initial?.names || []));
  const [name, setName] = useState(initial?.name || '');
  const [content, setContent] = useState(initial?.content || '');
  const [url, setUrl] = useState(initial?.url || '');
  const [found, setFound] = useState(null);

  useEffect(() => {
    api.skillsLocal().then((r) => setLocal(r.skills)).catch((e) => { setLocal([]); setErr(e.message); });
  }, []);

  const go = async (body) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.importSkills({ ...body, rename });
      if (r.candidates) {
        setFound(r.candidates);
        setPicked(new Set(r.candidates.map((c) => c.name)));
      } else {
        toast(t('Đã nhập: {n}', { n: r.imported.join(', ') }), 'ok');
        onDone();
        onClose();
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const names = [...picked];
  const switchTab = (k) => { setTab(k); setErr(null); setPicked(new Set()); setFound(null); };

  const tabs = [['local', t('Từ máy')], ['text', t('Dán nội dung')], ['github', 'GitHub']];
  return (
    <Modal title={t('Nhập skill')} lead={t(WARN)} onClose={onClose} wide busy={busy}>
      <div className="sk-tabs" role="group" aria-label={t('Nguồn skill')}>
        {tabs.map(([k, label]) => (
          <button key={k} type="button" className={`btn sm${tab === k ? ' primary' : ''}`} aria-pressed={tab === k} onClick={() => switchTab(k)}>{label}</button>
        ))}
      </div>

      {tab === 'local' ? (
        local == null ? <Sk w="12em" /> : local.length ? (
          <>
            <p className="note">{t('Skill tìm thấy trong ~/.claude/skills — nhập sẽ chép một bản vào thư viện của app.')}</p>
            <PickList items={local} picked={picked} setPicked={setPicked} />
          </>
        ) : <p className="note">{t('Không tìm thấy skill nào trong ~/.claude/skills.')}</p>
      ) : null}

      {tab === 'text' ? (
        <>
          <label className="fld">
            <span>{t('Tên skill')}</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('để trống = lấy từ "name" trong SKILL.md')} />
          </label>
          <label className="fld">
            <span>{t('Nội dung SKILL.md')}</span>
            <textarea className="mono-in" rows={10} required aria-required="true" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
            <span className="hint">
              {t('Hoặc chọn file:')} <input type="file" accept=".md,text/markdown,text/plain" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setContent(await f.text()); }} />
            </span>
          </label>
        </>
      ) : null}

      {tab === 'github' ? (
        <>
          <label className="fld">
            <span>{t('Link GitHub')}<Req /></span>
            <input type="text" required aria-required="true" value={url} onChange={(e) => { setUrl(e.target.value); setFound(null); }} placeholder="https://github.com/chủ/repo" />
            <span className="hint">{t('Repo công khai; có thể trỏ vào nhánh/thư mục: /tree/nhánh/thư-mục. Cần máy đã cài git.')}</span>
          </label>
          {found ? <PickList items={found} picked={picked} setPicked={setPicked} /> : null}
        </>
      ) : null}

      <label className="chk">
        <input type="checkbox" checked={rename} onChange={(e) => setRename(e.target.checked)} />
        <span>{t('Trùng tên thì nhập thành bản mới (thêm -2, -3…) thay vì báo lỗi')}</span>
      </label>
      <p className="hint">{t('Skill mới nhập mặc định "Dùng chung"; tick kênh áp dụng ngay trên bảng Skills.')}</p>
      {err ? <div className="err-note" role="alert">{err}</div> : null}
      <div className="modal-acts">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('Hủy')}</button>
        {tab === 'local' ? <button type="button" className="btn primary" disabled={busy || !names.length} onClick={() => go({ source: 'local', names })}>{t('Nhập {n} skill', { n: names.length })}</button> : null}
        {tab === 'text' ? <button type="button" className="btn primary" disabled={busy || !content.trim()} onClick={() => go({ source: 'text', name: name.trim() || undefined, content })}>{t('Nhập')}</button> : null}
        {tab === 'github' && !found ? <button type="button" className="btn primary" disabled={busy || !url.trim()} onClick={() => go({ source: 'github', url: url.trim() })}>{busy ? t('Đang tải…') : t('Tìm skill')}</button> : null}
        {tab === 'github' && found ? <button type="button" className="btn primary" disabled={busy || !names.length} onClick={() => go({ source: 'github', url: url.trim(), names })}>{busy ? t('Đang tải…') : t('Nhập {n} skill', { n: names.length })}</button> : null}
      </div>
    </Modal>
  );
}

function DeleteModal({ skill, onClose, onDone }) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async () => {
    setBusy(true);
    try {
      await api.deleteSkill(skill.name);
      toast(t('Đã xóa skill "{n}".', { n: skill.name }), 'ok');
      onDone();
      onClose();
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Xóa skill "{n}"?', { n: skill.name })} onClose={onClose} busy={busy}>
      <p>{t('Thư mục skill trong thư viện của app sẽ bị xóa (bản gốc ở nơi bạn nhập vào không bị đụng tới).')}</p>
      {skill.usedBy.length ? <div className="err-note" role="alert">{t('Đang được dùng bởi quy trình: {n}. Các quy trình này vẫn chạy nhưng sẽ không còn nạp skill này.', { n: skill.usedBy.map((u) => u.name).join(', ') })}</div> : null}
      {err ? <div className="err-note" role="alert">{err}</div> : null}
      <div className="modal-acts">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('Hủy')}</button>
        <button type="button" className="btn danger" onClick={go} disabled={busy}>{t('Xóa')}</button>
      </div>
    </Modal>
  );
}


// Ô tick phạm vi của một skill: chung (mọi kênh, kể cả kênh thêm sau) hoặc danh sách kênh cụ thể.
const inScope = (s, id) => s.shared || s.channels.includes(id);

// Gợi ý từ tìm kiếm AI: skill trên máy chưa nhập + link web (GitHub). Nhập luôn qua hộp thoại có cảnh báo tin cậy.
const short = (q, n = 80) => (q.length > n ? `${q.slice(0, n - 1)}…` : q);
// Tên thư mục skill từ nhu cầu: bỏ dấu, chữ thường, gạch nối.
const slug = (q) => q.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'skill-moi';

// Không tìm thấy gì: gợi ý từ khóa khác, tìm trên web, hoặc tự tạo skill (mở sẵn hộp Dán nội dung).
function NoMatch({ found, busy, onSearch, onCreate }) {
  const t = useT();
  const name = slug(found.query);
  return (
    <section className="card pad sk-sug sk-nomatch" aria-label={t('Gợi ý từ AI')}>
      <h2>{t('Gợi ý từ AI')}</h2>
      {found.tip ? <p className="sk-tip">{found.tip}</p> : null}
      {found.alternatives?.length ? (
        <div>
          <span className="muted">{t('Thử tìm bằng từ khóa khác:')}</span>
          <div className="sk-alts">
            {found.alternatives.map((a) => <button key={a} type="button" className="chip" disabled={busy} onClick={() => onSearch(false, a)}>{a}</button>)}
          </div>
        </div>
      ) : null}
      <div className="sk-chat-acts sk-nomatch-acts">
        {!found.web ? <button type="button" className="btn sm" disabled={busy} onClick={() => onSearch(true, found.query)}>{t('Tìm rộng hơn trên web')}</button> : null}
        <button type="button" className="btn sm primary" onClick={() => onCreate({ tab: 'text', name, content: `---\nname: ${name}\ndescription: ${found.query.replace(/\s+/g, ' ').slice(0, 200)}\n---\n\n# ${name}\n\n` })}>{t('Tạo skill mới')}</button>
      </div>
    </section>
  );
}

// Dải % phù hợp theo kênh cho một gợi ý (skill trên máy / web chưa nhập nên chưa có checkbox).
function Fit({ scores, channels }) {
  const t = useT();
  if (!channels.length || !scores) return null;
  return (
    <span className="sk-fit" aria-label={t('Mức phù hợp theo kênh')}>
      {channels.map((c) => {
        const pct = scores[c.id];
        return <span key={c.id} className={`sk-pct-chip ${pct == null ? 'na' : tone(pct)}`} title={t('Mức phù hợp với kênh {c}: {n}% (AI ước lượng)', { c: c.name || c.id, n: pct ?? '—' })}>{c.name || c.id}: <b>{pct == null ? '—' : `${pct}%`}</b></span>;
      })}
    </span>
  );
}

function Suggestions({ local, web, channels, onImport }) {
  const t = useT();
  if (!local.length && !web.length) return null;
  return (
    <section className="card pad sk-sug" aria-label={t('Gợi ý')}>
      <h2>{t('Gợi ý')}</h2>
      <ul>
        {local.map((m) => (
          <li key={`l-${m.name}`}>
            <span><b>{m.name}</b> <span className="muted">· {t('trên máy, chưa nhập')}</span>{m.reason ? <span className="hint">{m.reason}</span> : null}<Fit scores={m.scores} channels={channels} /></span>
            <button type="button" className="btn sm" onClick={() => onImport({ tab: 'local', names: [m.name] })}>{t('Nhập')}</button>
          </li>
        ))}
        {web.map((w) => (
          <li key={w.url}>
            <span><b>{w.title}</b> <span className="muted">· {t('trên web')}</span><span className="hint mono">{w.url}</span>{w.reason ? <span className="hint">{w.reason}</span> : null}<Fit scores={w.scores} channels={channels} /></span>
            <button type="button" className="btn sm" onClick={() => onImport({ tab: 'github', url: w.url })}>{t('Nhập')}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Bảng skill dùng chung cho thư viện và kết quả tìm; có `scores` (tên → {kênh: %}) thì mỗi ô kênh hiện thêm % phù hợp.
const tone = (n) => (n >= 70 ? 'hi' : n >= 40 ? 'mid' : 'lo');
function SkTable({ rows, channels, reasons, scores, onAll, onChannel, onEdit, onDelete }) {
  const t = useT();
  return (
    <div className="sk-tbl-wrap">
      <table className="sk-tbl">
        <thead>
          <tr>
            <th scope="col" className="sk-name">{t('Tên skill')}</th>
            <th scope="col">{t('Mô tả')}</th>
            <th scope="col" className="sk-ck">{t('Tất cả kênh')}</th>
            {channels.map((c) => <th scope="col" key={c.id} className="sk-ck" title={c.name || c.id}><span>{c.name || c.id}</span></th>)}
            <th scope="col" className="sk-act"><span className="sr-only">{t('Hành động')}</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.name} className={scores ? 'hit' : undefined}>
              <th scope="row" className="sk-name">
                <b>{s.name}</b>
                <span className="muted">{s.usedBy.length ? t('Dùng trong {n} quy trình', { n: s.usedBy.length }) : t('Chưa gắn vào quy trình nào')}</span>
              </th>
              <td className="sk-desc">
                <span title={s.description || undefined}>{s.description || '—'}</span>
                {reasons?.get(s.name) ? <span className="hint">{reasons.get(s.name)}</span> : null}
              </td>
              <td className="sk-ck">
                <input type="checkbox" checked={s.shared} onChange={(e) => onAll(s, e.target.checked)} aria-label={t('Dùng "{s}" cho tất cả kênh', { s: s.name })} />
              </td>
              {channels.map((c) => {
                const pct = scores?.get(s.name)?.[c.id];
                return (
                  <td key={c.id} className="sk-ck">
                    <input type="checkbox" checked={inScope(s, c.id)} onChange={(e) => onChannel(s, c.id, e.target.checked)} aria-label={t('Dùng "{s}" cho kênh {c}', { s: s.name, c: c.name || c.id })} />
                    {scores ? (
                      <span className={`sk-pct ${pct == null ? 'na' : tone(pct)}`} title={pct == null ? undefined : t('Mức phù hợp với kênh {c}: {n}% (AI ước lượng)', { c: c.name || c.id, n: pct })}>
                        {pct == null ? '—' : <><b>{pct}%</b><i style={{ width: `${Math.max(2, Math.round(pct * 0.44))}px` }} aria-hidden="true" /></>}
                      </span>
                    ) : null}
                  </td>
                );
              })}
              <td className="sk-act">
                <span className="sk-acts">
                  <button type="button" className="btn sm" onClick={() => onEdit(s.name)}>{t('Xem / sửa')}</button>
                  <button type="button" className="btn sm ghost" onClick={() => onDelete(s)}>{t('Xóa')}</button>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Skills({ onReloadPresets }) {
  const t = useT();
  const toast = useToast();
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [edit, setEdit] = useState(null);
  const [imp, setImp] = useState(null);
  const [del, setDel] = useState(null);
  const [repo, setRepo] = useState(false);
  const [channels, setChannels] = useState([]);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(null); // 'ai' | 'web' khi đang tìm
  const [found, setFound] = useState(null); // {query, web, matches, suggestions}
  const [searchErr, setSearchErr] = useState(null);
  const [tab, setTab] = useState('lib'); // 'lib' thư viện | 'search' tìm skill
  const [chat, setChat] = useState(null); // thảo luận: {query, answers:[{q,a}], question, options, busy, text}

  const load = useCallback(() => {
    api.skills().then((r) => { setList(r.skills); setErr(null); }).catch((e) => setErr(e));
  }, []);
  useEffect(load, [load]);
  useEffect(() => { api.channels().then((c) => setChannels(Array.isArray(c) ? c : [])).catch(() => {}); }, []);
  const changed = () => { load(); onReloadPresets?.(); };

  // Lưu phạm vi ngay khi tick: cập nhật trước cho mượt, lỗi thì tải lại + báo.
  const saveScope = async (s, scope) => {
    const next = scope.all ? { shared: true, channels: [] } : { shared: false, channels: scope.channels };
    setList((l) => l.map((x) => (x.name === s.name ? { ...x, ...next } : x)));
    try {
      const d = await api.setSkillScope(s.name, scope);
      setList((l) => l.map((x) => (x.name === s.name ? { ...x, shared: d.shared, channels: d.channels } : x)));
      onReloadPresets?.();
    } catch (e) {
      toast(e.message, 'err');
      load();
    }
  };
  const toggleAll = (s, on) => saveScope(s, on ? { all: true } : { channels: [] });
  const toggleChannel = (s, id, on) => {
    const ids = channels.map((c) => c.id);
    const cur = s.shared ? ids : s.channels.filter((c) => ids.includes(c));
    // Đang "Tất cả" mà bỏ một kênh → thành danh sách kênh cụ thể (các kênh còn lại).
    saveScope(s, { channels: on ? [...new Set([...cur, id])] : cur.filter((c) => c !== id) });
  };

  const search = async (web, text) => {
    const q = (text ?? query).trim();
    if (!q || searching) return;
    setSearching(web ? 'web' : 'ai');
    setSearchErr(null);
    try {
      const r = await api.searchSkills(q, web);
      setFound({ query: q, web, matches: r.matches || [], suggestions: r.suggestions || [], alternatives: r.alternatives || [], tip: r.tip || '' });
    } catch (e) {
      setSearchErr(e.message);
    } finally {
      setSearching(null);
    }
  };
  const clear = () => { setFound(null); setSearchErr(null); };

  // Thảo luận: AI hỏi từng câu; đủ thông tin thì điền nhu cầu đã tinh chỉnh vào ô tìm và tìm luôn.
  const turn = async (q, answers) => {
    setChat((c) => ({ ...c, query: q, answers, busy: true, text: '' }));
    setSearchErr(null);
    try {
      const r = await api.clarifySkills(q, answers);
      if (r.done) {
        setChat(null);
        setQuery(r.refined);
        await search(false, r.refined);
      } else {
        setChat((c) => (c ? { ...c, busy: false, question: r.question, options: r.options || [] } : c)); // đã Hủy khi AI còn đang nghĩ → bỏ qua
      }
    } catch (e) {
      setChat(null);
      setSearchErr(e.message);
    }
  };
  const startChat = () => {
    const q = query.trim();
    if (!q || searching || chat) return;
    turn(q, []);
  };
  const answer = (a) => {
    const v = a.trim();
    if (!v || chat.busy) return;
    turn(chat.query, [...chat.answers, { q: chat.question, a: v }]);
  };

  const reasons = new Map((found?.matches || []).filter((m) => m.source === 'library').map((m) => [m.name, m.reason]));
  const scores = found ? new Map((found.matches || []).filter((m) => m.source === 'library').map((m) => [m.name, m.scores || {}])) : null;
  const best = (n) => Math.max(-1, ...Object.values(scores?.get(n) || {}));
  // Xếp theo % cao nhất giữa các kênh (ổn định: bằng nhau thì giữ thứ tự AI).
  const order = (found?.matches || []).filter((m) => m.source === 'library').map((m) => m.name).map((n, i) => [n, i]).sort((x, y) => best(y[0]) - best(x[0]) || x[1] - y[1]).map((x) => x[0]);
  const shown = !list || !found ? [] : order.map((n) => list.find((s) => s.name === n)).filter(Boolean);
  const localHits = (found?.matches || []).filter((m) => m.source === 'local');

  return (
    <>
      <div className="page-h" data-ai-help="skills">
        <h1>Skills</h1>
        <div className="sk-acts">
          <button type="button" className="btn sm" onClick={load}>{t('Tải lại')}</button>
          <button type="button" className="btn sm" onClick={() => setRepo(true)}>{t('Kho skill của tôi')}</button>
          <button type="button" className="btn sm primary" onClick={() => setImp({})}>{t('Nhập skill')}</button>
        </div>
      </div>
      <p className="note">{t('Thư viện skill của app. Tick kênh nào dùng skill nào ngay trên bảng; ô "Tất cả kênh" áp dụng cho cả kênh thêm sau. Gắn skill vào quy trình ở bước 2 khi tạo/sửa quy trình — chỉ skill được chọn mới được nạp cho các bước của quy trình đó.')}</p>
      {err ? <div className="err-note" role="alert">{t('Không tải được skill:')} {err.message}</div> : null}
      {!list && !err ? (
        <SkZone className="bp-list" label={t('Đang tải skill')}>
          <div className="bp card"><Sk w="9em" /><Sk w="20em" /></div>
        </SkZone>
      ) : null}
      {tab === 'lib' && list && !list.length ? (
        <div className="card pad empty">
          <b>{t('Chưa có skill nào.')}</b>
          <p className="note">{t('Bấm "Nhập skill" để lấy từ máy, dán nội dung hoặc tải từ GitHub.')}</p>
        </div>
      ) : null}
      {list ? (
        <div className="sk-tabs" role="group" aria-label={t('Skills')}>
          <button type="button" className={`btn sm${tab === 'lib' ? ' primary' : ''}`} aria-pressed={tab === 'lib'} onClick={() => setTab('lib')}>{t('Thư viện')}</button>
          <button type="button" className={`btn sm${tab === 'search' ? ' primary' : ''}`} aria-pressed={tab === 'search'} onClick={() => setTab('search')}>{t('Tìm skill')}</button>
        </div>
      ) : null}
      {tab === 'lib' && list?.length ? <SkTable rows={list} channels={channels} onAll={toggleAll} onChannel={toggleChannel} onEdit={setEdit} onDelete={setDel} /> : null}
      {list && tab === 'search' ? (
        <form className="sk-search" onSubmit={(e) => { e.preventDefault(); search(false); }} role="search" aria-label={t('Tìm skill bằng AI')}>
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={500} placeholder={t('Mô tả skill cần tìm, ví dụ: làm video người que (AI)')} aria-label={t('Mô tả skill cần tìm')} disabled={!!searching || !!chat} />
          <button type="submit" className="btn sm primary" disabled={!query.trim() || !!searching || !!chat}>{searching === 'ai' ? <><i className="spinner on-acc" aria-hidden="true" />{t('Đang tìm…')}</> : t('Tìm nhanh')}</button>
          <button type="button" className="btn sm" disabled={!query.trim() || !!searching || !!chat} onClick={startChat} title={t('AI hỏi lại vài câu để chọn skill chính xác hơn')}>{t('Thảo luận')}</button>
          <button type="button" className="btn sm" disabled={!query.trim() || !!searching || !!chat} onClick={() => search(true)} title={t('Tìm thêm trên web — chậm hơn và tốn token hơn')}>{searching === 'web' ? <><i className="spinner" aria-hidden="true" />{t('Đang tìm…')}</> : t('Tìm rộng hơn trên web')}</button>
          {found ? <button type="button" className="btn sm ghost" onClick={clear}>{t('Xóa lọc')}</button> : null}
        </form>
      ) : null}
      {tab === 'search' && chat ? (
        <div className="sk-chat card pad" role="group" aria-label={t('Thảo luận để chọn skill')}>
          {chat.answers.map((x, i) => (
            <p key={i} className="sk-chat-qa"><b>{x.q}</b><br /><span className="muted">{x.a}</span></p>
          ))}
          {chat.busy ? (
            <p className="sk-chat-wait" role="status"><i className="spinner" aria-hidden="true" /> {t('AI đang nghĩ câu hỏi tiếp theo…')}</p>
          ) : (
            <>
              <p className="sk-chat-q"><b>{chat.question}</b></p>
              <div className="sk-chat-opts">
                {chat.options.map((o) => <button key={o} type="button" className="btn sm" onClick={() => answer(o)}>{o}</button>)}
              </div>
              <form className="sk-chat-free" onSubmit={(e) => { e.preventDefault(); answer(chat.text || ''); }}>
                <input type="text" value={chat.text || ''} maxLength={300} onChange={(e) => setChat((c) => ({ ...c, text: e.target.value }))} placeholder={t('Hoặc tự trả lời…')} aria-label={t('Câu trả lời của bạn')} />
                <button type="submit" className="btn sm primary" disabled={!(chat.text || '').trim()}>{t('Trả lời')}</button>
              </form>
            </>
          )}
          <div className="sk-chat-acts">
            <button type="button" className="btn sm" onClick={() => { const q = chat.query; setChat(null); search(false, q); }} disabled={chat.busy}>{t('Tìm luôn')}</button>
            <button type="button" className="btn sm ghost" onClick={() => setChat(null)}>{t('Hủy')}</button>
          </div>
        </div>
      ) : null}
      {tab === 'search' && searching ? (
        <div className="sk-wait" role="status">
          <div className="sk-wait-bar" aria-hidden="true"><i /></div>
          <span>{searching === 'web' ? t('Trợ lý đang tìm trong thư viện và trên web… có thể mất vài phút.') : t('Trợ lý đang tìm skill phù hợp… có thể mất vài chục giây.')}</span>
        </div>
      ) : null}
      {tab === 'search' && searchErr ? <div className="err-note" role="alert">{searchErr}</div> : null}
      {tab === 'search' && found ? <p className="note" role="status">{shown.length || localHits.length || found.suggestions.length ? t('Kết quả cho "{q}": {n} skill trong thư viện.', { q: short(found.query), n: shown.length }) : t('Không tìm thấy skill nào hợp với "{q}".', { q: short(found.query) })}</p> : null}
      {tab === 'search' && shown.length ? <SkTable rows={shown} channels={channels} reasons={reasons} scores={scores} onAll={toggleAll} onChannel={toggleChannel} onEdit={setEdit} onDelete={setDel} /> : null}
      {tab === 'search' && shown.length && channels.length ? <p className="note">{t('% là mức phù hợp AI ước lượng cho từng kênh, chỉ để tham khảo; tick ô để áp dụng skill cho kênh.')}</p> : null}
      {tab === 'lib' && list?.length && !channels.length ? <p className="note">{t('Chưa có kênh nào — skill đang "Dùng chung". Thêm kênh ở tab Kênh để chọn skill riêng cho từng kênh.')}</p> : null}
      {tab === 'search' && found && !shown.length && !localHits.length && !found.suggestions.length ? <NoMatch found={found} busy={!!searching} onSearch={(web, q) => { setQuery(q); search(web, q); }} onCreate={setImp} /> : null}
      {tab === 'search' && found ? <Suggestions local={localHits} web={found.suggestions} channels={channels} onImport={setImp} /> : null}
      {edit ? <SkillEditor name={edit} onClose={() => setEdit(null)} onSaved={changed} /> : null}
      {imp ? <ImportModal initial={imp.tab ? imp : null} onClose={() => setImp(null)} onDone={changed} /> : null}
      {repo ? <SkillRepo onClose={() => setRepo(false)} onChanged={changed} /> : null}
      {del ? <DeleteModal skill={del} onClose={() => setDel(null)} onDone={changed} /> : null}
    </>
  );
}
