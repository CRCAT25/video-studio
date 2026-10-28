// "Kho skill của tôi": repo git riêng chứa skill của người dùng. Tạo kho (3 bước), đẩy skill lên, kéo bản mới về.
import { useCallback, useEffect, useState } from 'react';
import Modal from '../components/Modal.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../api.js';
import { T, useT } from '../lib/i18n.jsx';

const NEW_REPO = 'https://github.com/new?name=my-skills&visibility=public';

function Wizard({ st, onDone }) {
  const t = useT();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async (body) => {
    setBusy(true);
    setErr(null);
    try {
      await api.skillRepoInit(body);
      toast(t('Đã tạo kho skill.'), 'ok');
      onDone();
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return (
    <>
      <p>{t('Kho skill là một repo GitHub của riêng bạn. Đẩy skill lên đó để sao lưu, chia sẻ, và cài lại trên máy khác chỉ bằng một lệnh.')}</p>
      {!st.hasGit ? <div className="err-note" role="alert">{t('Máy chưa cài git — cài git rồi mở lại cửa sổ này.')}</div> : null}
      <div className="row" role="group" aria-label={t('Bạn đã có repo skill chưa?')}>
        <button type="button" className={`btn sm${mode === 'have' ? ' primary' : ''}`} onClick={() => setMode('have')}>{t('Tôi đã có repo')}</button>
        <button type="button" className={`btn sm${mode === 'new' ? ' primary' : ''}`} onClick={() => setMode('new')}>{t('Tôi chưa có repo')}</button>
      </div>
      {mode === 'have' ? (
        <div className="sk-steps">
          <b>{t('Dán địa chỉ repo')}</b>
          <p className="note">{t('Nếu repo đã có skill, app sẽ tải về và bạn chọn skill nào lấy vào thư viện.')}</p>
          <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/ten-ban/my-skills" aria-label={t('Địa chỉ repo GitHub')} disabled={busy} />
          <button type="button" className="btn sm primary" disabled={busy || !st.hasGit || !url.trim()} onClick={() => go({ url: url.trim() })}>{busy ? <><i className="spinner on-acc" aria-hidden="true" />{t('Đang kết nối…')}</> : t('Kết nối')}</button>
        </div>
      ) : null}
      {mode === 'new' ? (
        <ol className="sk-steps">
          <li>
            <b>{t('Tạo repo trống trên GitHub')}</b>
            <p className="note">{t('Mở trang tạo repo (đã điền sẵn tên my-skills), bấm "Create repository" và đừng thêm README.')}</p>
            <a className="btn sm" href={NEW_REPO} target="_blank" rel="noopener noreferrer">{t('Mở github.com/new')}</a>
            {st.ghLoggedIn ? (
              <button type="button" className="btn sm" disabled={busy || !st.hasGit} onClick={() => go({ createWithGh: true, name: 'my-skills' })} title={t('Dùng gh (đã đăng nhập) để tạo repo công khai my-skills và nối luôn')}>{t('Hoặc tạo bằng gh')}</button>
            ) : null}
          </li>
          <li>
            <b>{t('Dán địa chỉ repo vừa tạo')}</b>
            <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/ten-ban/my-skills" aria-label={t('Địa chỉ repo GitHub')} disabled={busy} />
            <button type="button" className="btn sm primary" disabled={busy || !st.hasGit || !url.trim()} onClick={() => go({ url: url.trim() })}>{busy ? <><i className="spinner on-acc" aria-hidden="true" />{t('Đang kết nối…')}</> : t('Kết nối')}</button>
          </li>
        </ol>
      ) : null}
      {err ? <div className="err-note" role="alert">{err}</div> : null}
    </>
  );
}

const STATE = { new: T('Mới (chưa có trên kho)'), changed: T('Khác nhau'), same: T('Giống nhau'), repo_only: T('Chỉ có trên kho') };

function Manage({ st, reload }) {
  const t = useT();
  const toast = useToast();
  const [sel, setSel] = useState(new Set());
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [step, setStep] = useState(null); // {kind:'push', findings, force} | {kind:'apply'}
  const rows = st.skills;
  const toggle = (n) => setSel((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });
  const chosen = rows.filter((r) => sel.has(r.name));
  const canPush = chosen.length > 0 && chosen.every((r) => r.state !== 'repo_only');
  const canApply = chosen.length > 0 && chosen.every((r) => r.state !== 'new');
  const names = chosen.map((r) => r.name);

  const wrap = async (key, fn) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };
  const askPush = () => wrap('scan', async () => {
    const r = await api.skillRepoScan(names);
    setStep({ kind: 'push', findings: r.findings, force: false });
  });
  const doPush = () => wrap('push', async () => {
    const r = await api.skillRepoPublish({ names, confirm: true, force: step.force });
    setStep(null);
    setSel(new Set());
    if (r.pushed) toast(t('Đã đẩy {n} skill lên kho.', { n: r.names.length }), 'ok');
    else toast(r.hint === 'no_remote' ? t('Đã lưu vào kho trên máy, nhưng kho chưa có địa chỉ GitHub.') : t('Đã lưu vào kho trên máy nhưng chưa đẩy lên GitHub được — kiểm tra đăng nhập git (gh auth login) rồi thử lại.'), 'err');
    reload();
  });
  const doApply = () => wrap('apply', async () => {
    await api.skillRepoApply(names);
    setStep(null);
    setSel(new Set());
    toast(t('Đã cập nhật {n} skill trong thư viện.', { n: names.length }), 'ok');
    reload();
  });
  const pull = () => wrap('pull', async () => {
    await api.skillRepoPull();
    toast(t('Đã kéo bản mới của kho.'), 'ok');
    reload();
  });

  return (
    <>
      <p className="note">
        {st.url ? <>{t('Kho:')} <a href={st.url} target="_blank" rel="noopener noreferrer">{st.url}</a> · </> : null}
        <code>{st.dir}</code>
      </p>
      {st.ahead ? <div className="err-note" role="status">{t('Có {n} thay đổi đã lưu ở máy nhưng chưa đẩy lên GitHub. Đẩy lại một skill bất kỳ để gửi lên.', { n: st.ahead })}</div> : null}
      <div className="sk-acts">
        <button type="button" className="btn sm" disabled={!!busy || !st.url} onClick={pull}>{busy === 'pull' ? <><i className="spinner" aria-hidden="true" />{t('Đang kéo…')}</> : t('Cập nhật skill')}</button>
      </div>
      {rows.length ? (
        <table className="sk-tbl">
          <thead><tr><th /><th>{t('Skill')}</th><th>{t('Trạng thái')}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td><input type="checkbox" checked={sel.has(r.name)} onChange={() => { toggle(r.name); setStep(null); }} aria-label={r.name} /></td>
                <td>{r.name}</td>
                <td>{t(STATE[r.state])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="note">{t('Chưa có skill nào trong thư viện hay trên kho.')}</p>}
      {step?.kind === 'push' ? (
        <div className="card pad" role="group" aria-label={t('Xác nhận đẩy')}>
          <b>{t('Đẩy {n} skill lên {u}?', { n: names.length, u: st.url || t('kho trên máy') })}</b>
          <p className="note">{t('Nếu repo là công khai thì ai cũng xem được nội dung này.')}</p>
          {step.findings.length ? (
            <>
              <div className="err-note" role="alert">{t('Có thể có thông tin riêng tư ({n} chỗ) — xem lại và sửa skill trước khi đẩy:', { n: step.findings.length })}</div>
              <ul className="sk-find">
                {step.findings.slice(0, 20).map((f, i) => <li key={i}><code>{f.skill}/{f.file}:{f.line}</code> — {f.excerpt}</li>)}
              </ul>
              <label className="chk"><input type="checkbox" checked={step.force} onChange={(e) => setStep({ ...step, force: e.target.checked })} /> {t('Tôi đã xem, vẫn muốn đẩy')}</label>
            </>
          ) : <p className="note">{t('Không phát hiện đường dẫn cá nhân, email hay khóa bí mật.')}</p>}
          <div className="modal-acts">
            <button type="button" className="btn" onClick={() => setStep(null)} disabled={!!busy}>{t('Hủy')}</button>
            <button type="button" className="btn primary" onClick={doPush} disabled={!!busy || (step.findings.length > 0 && !step.force)}>{busy === 'push' ? <><i className="spinner on-acc" aria-hidden="true" />{t('Đang đẩy…')}</> : t('Xác nhận đẩy')}</button>
          </div>
        </div>
      ) : null}
      {step?.kind === 'apply' ? (
        <div className="card pad" role="group" aria-label={t('Xác nhận cập nhật')}>
          <b>{t('Lấy {n} skill từ kho về thư viện?', { n: names.length })}</b>
          <p className="note">{t('Bản trong thư viện sẽ bị ghi đè bằng bản trên kho (phạm vi kênh được giữ nguyên).')}</p>
          <div className="modal-acts">
            <button type="button" className="btn" onClick={() => setStep(null)} disabled={!!busy}>{t('Hủy')}</button>
            <button type="button" className="btn primary" onClick={doApply} disabled={!!busy}>{t('Xác nhận cập nhật')}</button>
          </div>
        </div>
      ) : null}
      {!step ? (
        <div className="modal-acts">
          <button type="button" className="btn" disabled={!canApply || !!busy} onClick={() => setStep({ kind: 'apply' })}>{t('Lấy về thư viện')}</button>
          <button type="button" className="btn primary" disabled={!canPush || !!busy} onClick={askPush}>{busy === 'scan' ? <><i className="spinner on-acc" aria-hidden="true" />{t('Đang kiểm tra…')}</> : t('Đẩy lên kho')}</button>
        </div>
      ) : null}
      {err ? <div className="err-note" role="alert">{err}</div> : null}
      <p className="note">{t('Cài trên máy khác: clone repo rồi chạy ./sync.sh (macOS/Linux) hoặc .\\sync.ps1 (Windows). Chạy lại lệnh đó bất cứ lúc nào để lấy bản mới.')}</p>
    </>
  );
}

export default function SkillRepo({ onClose, onChanged }) {
  const t = useT();
  const [st, setSt] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(() => {
    api.skillRepo().then((s) => { setSt(s); setErr(null); }).catch((e) => setErr(e.message));
  }, []);
  useEffect(load, [load]);
  const reload = () => { load(); onChanged?.(); };
  return (
    <Modal title={t('Kho skill của tôi')} onClose={onClose} wide>
      {err ? <div className="err-note" role="alert">{err}</div> : null}
      {!st && !err ? <p className="note" role="status">{t('Đang tải…')}</p> : null}
      {st && !st.configured ? <Wizard st={st} onDone={reload} /> : null}
      {st?.configured ? <Manage st={st} reload={reload} /> : null}
    </Modal>
  );
}
