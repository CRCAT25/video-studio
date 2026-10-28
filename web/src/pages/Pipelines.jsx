// Trang Quy trình: "Gợi ý" (chọn định dạng → sửa bước → lưu) và "Quy trình của tôi" (thẻ gọn, chi tiết thu gọn, xóa).
import { useEffect, useState } from 'react';
import Flow from '../components/Flow.jsx';
import FormatPicker, { DEFAULT_FORMAT, FormatPickerSkeleton, flowSteps, useCatalog, useSuggestion } from '../components/FormatPicker.jsx';
import Modal from '../components/Modal.jsx';
import { RowMenu } from './Channels.jsx';
import { PresetErrors } from '../components/NewProjectModal.jsx';
import { Sk, SkFlow, SkZone } from '../components/Skeleton.jsx';
import Req from '../components/Req.jsx';
import SkillPicker from '../components/SkillPicker.jsx';
import StepEditor, { stepProblem } from '../components/StepEditor.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../api.js';
import { fmtDuration, gateLabel, two } from '../lib/format.js';
import { T, tr, useT } from '../lib/i18n.jsx';

const PERM = [
  ['allow', T('Cho phép')],
  ['ask', T('Hỏi')],
  ['deny', T('Chặn')],
];

function Kv({ k, children }) {
  return (
    <div className="kv">
      <span>{k}</span>
      <b>{children}</b>
    </div>
  );
}

const LEN = { short: T('Video ngắn'), long: T('Video dài') };
const ORI = { vertical: T('dọc'), horizontal: T('ngang'), square: T('vuông') };
function formatText(p) {
  const raw = p.pipeline || {};
  const parts = [LEN[p.format] ? tr(LEN[p.format]) : p.format, ORI[raw.orientation] ? tr(ORI[raw.orientation]) : undefined, raw.aspect, p.vars?.duration_label].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
}

function costText(c) {
  if (!c) return '—';
  const est = c.estimate != null && c.estimate !== '' ? ` · ${c.estimate}` : '';
  return `${c.service || tr('dịch vụ')}${est}${c.always_ask ? ` · ${tr('luôn hỏi')}` : ''}`;
}

// Chi tiết một quy trình (hiện trong hộp thoại): dải bước, thông tin, quyền, bảng bước, YAML.
function PresetDetail({ p, channelName }) {
  const t = useT();
  const steps = p.steps || [];
  const perms = p.permissions || {};
  const vars = p.vars && typeof p.vars === 'object' ? Object.entries(p.vars) : [];
  return (
    <>
      <Flow steps={steps} staticMode label={t('Các bước của {n}', { n: p.name })} />
      <div className="spec">
        <div className="blk">
          <h3>{t('Thông tin')}</h3>
          <Kv k={t('Kênh')}>{channelName || p.channel || '—'}</Kv>
          <Kv k={t('Định dạng')}>{formatText(p)}</Kv>
          <Kv k={t('Thư mục')}><span className="mono">{p.project_dir || '—'}</span></Kv>
          <Kv k="Skills"><span className="mono">{p.skills?.length ? p.skills.map((x) => String(x).split(/[\\/]/).filter(Boolean).pop()).join(', ') : '—'}</span></Kv>
          {vars.map(([k, v]) => (
            <Kv key={k} k={`vars.${k}`}>
              <span className="mono">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
            </Kv>
          ))}
        </div>
        <div className="blk">
          <h3>{t('Quyền của Claude')}</h3>
          {PERM.map(([k, label]) => (
            <div key={k} className={`perm ${k}`}>
              <span className="pl">{t(label)}</span>
              {(perms[k] || []).length ? (
                perms[k].map((r) => <code key={r}>{r}</code>)
              ) : (
                <span className="muted small">—</span>
              )}
            </div>
          ))}
        </div>
        <div className="blk">
          <h3>{t('Mặc định')}</h3>
          <Kv k={t('Cổng')}>{gateLabel(p.defaults?.gate)}</Kv>
          <Kv k={t('Giới hạn')}>{p.defaults?.timeout_ms ? fmtDuration(p.defaults.timeout_ms) : '—'}</Kv>
        </div>
      </div>

      <div className="tbl-wrap">
        <table className="steps-tbl">
          <thead>
            <tr>
              <th>#</th>
              <th>{t('Bước')}</th>
              <th>{t('Cổng')}</th>
              <th>{t('Chi phí')}</th>
              <th>{t('Kiểm tra')}</th>
              <th>{t('Đầu ra')}</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s, i) => (
              <tr key={s.key}>
                <td className="num dim">{two(i + 1)}</td>
                <td>
                  <b>{tr(s.name)}</b>
                  <div className="mono dim small">
                    {s.key}
                    {s.manual ? ` · ${t('việc tay')}` : ''}
                    {s.timeout_ms && s.timeout_ms !== p.defaults?.timeout_ms ? ` · ${fmtDuration(s.timeout_ms)}` : ''}
                  </div>
                </td>
                <td>{s.manual ? t('Việc tay') : gateLabel(s.gate)}</td>
                <td className={s.cost ? 'paid' : 'dim'}>{costText(s.cost)}</td>
                <td>
                  {s.checks?.length
                    ? s.checks.map((c) => (
                        <div key={c.name} title={c.run}>
                          {tr(c.name)}
                        </div>
                      ))
                    : <span className="dim">—</span>}
                </td>
                <td className="outs">{s.outputs?.length ? s.outputs.join(', ') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

        <details className="yaml">
          <summary>YAML</summary>
          <pre className="box-pre">{p.yaml || t('(trống)')}</pre>
        </details>
    </>
  );
}

// Gợi ý theo định dạng: xem trước, tùy chỉnh các bước rồi lưu thành quy trình của tôi.
function Suggest({ onSaved }) {
  const t = useT();
  const toast = useToast();
  const { catalog, error: catErr } = useCatalog();
  const [format, setFormat] = useState(DEFAULT_FORMAT);
  const [formatOk, setFormatOk] = useState(true);
  const sugg = useSuggestion(format);
  const [draft, setDraft] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Gợi ý mới (đổi định dạng) → nháp mới.
  useEffect(() => {
    if (!sugg.pipeline) return;
    setDraft({ ...sugg.pipeline, steps: sugg.pipeline.steps.map((s) => ({ ...s, enabled: s.enabled !== false })) });
    setName(sugg.pipeline.name);
    setErr(null);
  }, [sugg.pipeline]);

  const enabled = (draft?.steps || []).filter((s) => s.enabled !== false);
  const paid = enabled.filter((s) => s.cost).length;
  const nameT = name.trim();
  const canSave = !!draft && formatOk && !sugg.loading && enabled.length > 0 && !enabled.some((s) => stepProblem(s)) && nameT && nameT.length <= 80 && !busy;

  const save = async (e) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.savePipeline(draft, nameT);
      toast(t('Đã lưu quy trình "{n}".', { n: r.name }), 'ok');
      onSaved?.();
    } catch (e2) {
      setErr({ message: e2.message, problems: e2.data?.problems || null });
    } finally {
      setBusy(false);
    }
  };

  if (catErr) return <div className="err-note" role="alert">{catErr.message}</div>;
  if (!catalog) {
    return (
      <SkZone className="card sg" label={t('Đang tải gợi ý')}>
        <div className="sg-fmt">
          <FormatPickerSkeleton />
        </div>
        <div className="sg-main">
          <SuggestMainSkeleton />
        </div>
      </SkZone>
    );
  }
  return (
    <form className="card sg" onSubmit={save} noValidate aria-label={t('Gợi ý quy trình')}>
      <div className="sg-fmt">
        <FormatPicker catalog={catalog} value={format} onChange={setFormat} onValidity={setFormatOk} disabled={busy} />
      </div>
      <div className="sg-main">
        {sugg.error ? <div className="err-note" role="alert">{sugg.error.message}</div> : null}
        {draft ? (
          <>
            <div className="bp-h">
              <h2>{tr(draft.name)}</h2>
              <span className="muted">
                {t('{n} bước', { n: enabled.length })}{paid ? ` · ${t('{n} tốn tiền (luôn hỏi trước)', { n: paid })}` : ''}
                {sugg.loading ? <span className="spinner" aria-hidden="true" /> : null}
              </span>
            </div>
            <Flow steps={flowSteps(draft.steps)} staticMode label={t('Các bước của {n}', { n: draft.name })} />
            <details className="bp-more">
              <summary>{t('Tùy chỉnh các bước')}</summary>
              <StepEditor key={draft.id} steps={draft.steps} library={catalog.steps} onChange={(steps) => setDraft((d) => ({ ...d, steps }))} disabled={busy} />
              <div className="fld">
                <span className="fld-l">Skills</span>
                <SkillPicker channelId={draft.channel || null} value={draft.skills || []} onChange={(skills) => setDraft((d) => ({ ...d, skills }))} disabled={busy} />
              </div>
            </details>
            <div className="sg-save">
              <span className="fld-l" style={{ flex: '0 0 100%', margin: 0 }}>{t('Tên quy trình')}<Req /></span>
              <input type="text" required aria-required="true" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t('Tên quy trình')} aria-label={t('Tên quy trình')} disabled={busy} />
              <button type="submit" className="btn primary" disabled={!canSave}>
                {busy ? <span className="spinner" aria-hidden="true" /> : null}{t('Lưu làm quy trình của tôi')}
              </button>
            </div>
            {err ? (
              <div className="err-note" role="alert">
                {err.message}
                {err.problems?.length > 1 ? (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {err.problems.map((m, i) => <li key={i}>{m}</li>)}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </>
        ) : !sugg.error ? (
          <SkZone className="sk-col" label={t('Đang tải gợi ý')}>
            <SuggestMainSkeleton />
          </SkZone>
        ) : null}
      </div>
    </form>
  );
}

// Khung chờ cột phải của Gợi ý: tiêu đề + số bước, dải bước, "Tùy chỉnh các bước", ô tên + nút lưu.
function SuggestMainSkeleton() {
  return (
    <>
      <div className="bp-h">
        <h2>
          <Sk w="10em" />
        </h2>
        <span className="muted">
          <Sk w="12em" />
        </span>
      </div>
      <SkFlow n={7} />
      <div className="bp-more sk-line">
        <Sk w="9em" />
      </div>
      <div className="sg-save">
        <Sk block h={36} style={{ flex: '1 1 220px' }} />
        <Sk block w={190} h={34} />
      </div>
    </>
  );
}

// Hộp thoại sửa một quy trình đã lưu: nạp bản gốc, chỉnh bước/skills/tên rồi ghi đè.
function EditModal({ preset, onClose, onSaved }) {
  const t = useT();
  const toast = useToast();
  const { catalog } = useCatalog();
  const [draft, setDraft] = useState(null);
  const [name, setName] = useState(preset.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api.pipeline(preset.id).then((r) => setDraft(r.pipeline), (e) => setErr({ message: e.message }));
  }, [preset.id]);
  const enabled = (draft?.steps || []).filter((s) => s.enabled !== false);
  const nameT = name.trim();
  const canSave = !!draft && enabled.length > 0 && !enabled.some((s) => stepProblem(s)) && nameT && nameT.length <= 80 && !busy;
  const save = async (e) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.updatePipeline(preset.id, draft, nameT);
      toast(t('Đã lưu quy trình "{n}".', { n: r.name }), 'ok');
      onSaved?.();
      onClose();
    } catch (e2) {
      setErr({ message: e2.message, problems: e2.data?.problems || null });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Sửa quy trình')} onClose={onClose} busy={busy} wide>
      {!draft || !catalog ? (
        err ? <div className="err-note" role="alert">{err.message}</div> : <span className="spinner" aria-hidden="true" />
      ) : (
        <form onSubmit={save} noValidate className="pe-form">
          <p className="note">{t('Dự án đã tạo từ quy trình này không bị ảnh hưởng.')}</p>
          <label className="fld">
            <span className="fld-l">{t('Tên quy trình')}<Req /></span>
            <input type="text" required aria-required="true" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label={t('Tên quy trình')} disabled={busy} />
          </label>
          <StepEditor steps={draft.steps} library={catalog.steps} onChange={(steps) => setDraft((d) => ({ ...d, steps }))} disabled={busy} />
          <details className="bp-more">
            <summary>Skills{draft.skills?.length ? ` (${draft.skills.length})` : ''}</summary>
            <SkillPicker channelId={draft.channel || null} value={draft.skills || []} onChange={(skills) => setDraft((d) => ({ ...d, skills }))} disabled={busy} />
          </details>
          {err ? (
            <div className="err-note" role="alert">
              {err.message}
              {err.problems?.length > 1 ? <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{err.problems.map((m, i) => <li key={i}>{m}</li>)}</ul> : null}
            </div>
          ) : null}
          <div className="modal-acts pe-acts">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('Hủy')}</button>
            <button type="submit" className="btn primary" disabled={!canSave}>
              {busy ? <span className="spinner" aria-hidden="true" /> : null}{t('Lưu')}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// Trang Quy trình: gợi ý, quy trình đã lưu, lỗi file YAML, nút tải lại.
export default function Pipelines({ data, error, channels = [], onReload }) {
  const t = useT();
  const toast = useToast();
  const presets = data?.presets || [];
  const errors = data?.errors || [];
  const chName = (id) => channels.find((c) => c.id === id)?.name;
  const [del, setDel] = useState(null);
  const [edit, setEdit] = useState(null);
  const [view, setView] = useState(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState(null);

  const doDelete = async () => {
    setDelBusy(true);
    setDelErr(null);
    try {
      await api.deletePipeline(del.id);
      toast(t('Đã xóa quy trình "{n}".', { n: del.name }), 'ok');
      setDel(null);
      onReload?.();
    } catch (e) {
      setDelErr(e.message);
    } finally {
      setDelBusy(false);
    }
  };

  return (
    <>
      <div className="page-h">
        <h1>{t('Quy trình')}</h1>
      </div>
      <h2 className="sec-h">{t('Gợi ý')}</h2>
      <Suggest onSaved={onReload} />

      <div className="page-h sec">
        <h2 className="sec-h">{t('Quy trình của tôi')}</h2>
        <button type="button" className="btn sm" onClick={onReload} title={t('Đọc lại các file YAML')}>
          {t('Tải lại')}
        </button>
      </div>
      {error ? (
        <div className="err-note" role="alert">
          {t('Không tải được quy trình:')} {error.message}
        </div>
      ) : null}
      {errors.length ? <PresetErrors errors={errors} /> : null}
      {!data && !error ? (
        <SkZone className="bp-list" label={t('Đang tải quy trình')}>
          {['9em', '12em'].map((w) => (
            <div key={w} className="bp card">
              <div className="bp-h">
                <h2>
                  <Sk w={w} />
                </h2>
                <span className="muted">
                  <Sk w="10em" />
                </span>
              </div>
              <SkFlow n={7} />
              <div className="bp-more sk-line">
                <Sk w="4em" />
              </div>
            </div>
          ))}
        </SkZone>
      ) : null}
      {data && !presets.length ? (
        <div className="card empty">{t('Chưa có quy trình nào. Chọn định dạng ở trên, tùy chỉnh rồi bấm Lưu.')}</div>
      ) : null}
      {presets.length ? (
        <div className="tbl-wrap yt-chlist">
          <table className="yt-tbl">
            <thead>
              <tr>
                <th>{t('Quy trình')}</th>
                <th className="num">{t('Bước')}</th>
                <th className="num hide-sm">{t('Tốn tiền')}</th>
                <th className="hide-sm">{t('Định dạng')}</th>
                <th>
                  <span className="sr-only">{t('Thao tác')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {presets.map((p) => {
                const n = (p.steps || []).length;
                const paid = (p.steps || []).filter((s) => s.cost).length;
                return (
                  <tr key={p.id}>
                    <td>
                      <button type="button" className="yt-chname link-btn" onClick={() => setView(p)}>{tr(p.name)}</button>
                      <span className="muted small yt-chst">
                        <span className="mono" title={p.file || ''}>{p.id}</span>{p.mine ? '' : ` · ${t('có sẵn')}`}
                      </span>
                    </td>
                    <td className="num">{n}</td>
                    <td className="num hide-sm">{paid || '—'}</td>
                    <td className="hide-sm">{formatText(p)}</td>
                    <td className="yt-chact">
                      <RowMenu
                        label={t('Thao tác với quy trình {n}', { n: p.name })}
                        items={[
                          { label: t('Xem chi tiết'), onClick: () => setView(p) },
                          ...(p.mine ? [{ label: t('Sửa'), onClick: () => setEdit(p) }, { sep: true }, { label: t('Xóa'), onClick: () => setDel(p), danger: true }] : []),
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {view ? (
        <Modal title={tr(view.name)} onClose={() => setView(null)} xwide>
          <PresetDetail p={view} channelName={chName(view.channel)} />
        </Modal>
      ) : null}
      {edit ? <EditModal preset={edit} onClose={() => setEdit(null)} onSaved={onReload} /> : null}
      {del ? (
        <Modal title={t('Xóa quy trình?')} onClose={() => setDel(null)} busy={delBusy}>
          <p className="note">
            {t('Xóa {n}. Dự án đã tạo từ quy trình này không bị ảnh hưởng.', { n: <b>{tr(del.name)}</b> })}
          </p>
          {delErr ? <div className="err-note" role="alert">{delErr}</div> : null}
          <div className="modal-acts">
            <button type="button" className="btn" onClick={() => setDel(null)} disabled={delBusy}>
              {t('Hủy')}
            </button>
            <button type="button" className="btn danger" onClick={doDelete} disabled={delBusy}>
              {delBusy ? <span className="spinner" aria-hidden="true" /> : null}{t('Xóa')}
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
