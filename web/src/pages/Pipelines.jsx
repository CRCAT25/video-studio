// Trang Quy trình: "Gợi ý" (chọn định dạng → sửa bước → lưu) và "Quy trình của tôi" (thẻ gọn, chi tiết thu gọn, xóa).
import { useEffect, useState } from 'react';
import Flow from '../components/Flow.jsx';
import FormatPicker, { DEFAULT_FORMAT, FormatPickerSkeleton, flowSteps, useCatalog, useSuggestion } from '../components/FormatPicker.jsx';
import Modal from '../components/Modal.jsx';
import { PresetErrors } from '../components/NewProjectModal.jsx';
import { Sk, SkFlow, SkZone } from '../components/Skeleton.jsx';
import StepEditor, { stepProblem } from '../components/StepEditor.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../api.js';
import { fmtDuration, gateLabel, two } from '../lib/format.js';

const PERM = [
  ['allow', 'Cho phép'],
  ['ask', 'Hỏi'],
  ['deny', 'Chặn'],
];

function Kv({ k, children }) {
  return (
    <div className="kv">
      <span>{k}</span>
      <b>{children}</b>
    </div>
  );
}

const LEN = { short: 'Video ngắn', long: 'Video dài' };
const ORI = { vertical: 'dọc', horizontal: 'ngang', square: 'vuông' };
function formatText(p) {
  const raw = p.pipeline || {};
  const parts = [LEN[p.format] || p.format, ORI[raw.orientation], raw.aspect, p.vars?.duration_label].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
}

function costText(c) {
  if (!c) return '—';
  const est = c.estimate != null && c.estimate !== '' ? ` · ${c.estimate}` : '';
  return `${c.service || 'dịch vụ'}${est}${c.always_ask ? ' · luôn hỏi' : ''}`;
}

// Thẻ một quy trình đã lưu; onDelete chỉ có với quy trình của tôi.
function PresetCard({ p, channelName, onDelete }) {
  const steps = p.steps || [];
  const perms = p.permissions || {};
  const vars = p.vars && typeof p.vars === 'object' ? Object.entries(p.vars) : [];
  const paidCount = steps.filter((s) => s.cost).length;
  return (
    <section className="bp card" aria-label={`Quy trình ${p.name}`}>
      <div className="bp-h">
        <h2>{p.name}</h2>
        <span className="muted">
          <span className="mono" title={p.file || ''}>{p.id}</span> · {steps.length} bước{paidCount ? ` · ${paidCount} tốn tiền` : ''}
          {p.mine ? null : ' · có sẵn'}
        </span>
        {onDelete ? (
          <button type="button" className="btn sm ghost bp-del" onClick={onDelete}>
            Xóa
          </button>
        ) : null}
      </div>
      <Flow steps={steps} staticMode label={`Các bước của ${p.name}`} />

      <details className="bp-more">
        <summary>Chi tiết</summary>
      <div className="spec">
        <div className="blk">
          <h3>Thông tin</h3>
          <Kv k="Kênh">{channelName || p.channel || '—'}</Kv>
          <Kv k="Định dạng">{formatText(p)}</Kv>
          <Kv k="Thư mục"><span className="mono">{p.project_dir || '—'}</span></Kv>
          <Kv k="Skills"><span className="mono">{p.skills?.length ? p.skills.join(', ') : '—'}</span></Kv>
          {vars.map(([k, v]) => (
            <Kv key={k} k={`vars.${k}`}>
              <span className="mono">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
            </Kv>
          ))}
        </div>
        <div className="blk">
          <h3>Quyền của Claude</h3>
          {PERM.map(([k, label]) => (
            <div key={k} className={`perm ${k}`}>
              <span className="pl">{label}</span>
              {(perms[k] || []).length ? (
                perms[k].map((r) => <code key={r}>{r}</code>)
              ) : (
                <span className="muted small">—</span>
              )}
            </div>
          ))}
        </div>
        <div className="blk">
          <h3>Mặc định</h3>
          <Kv k="Cổng">{gateLabel(p.defaults?.gate)}</Kv>
          <Kv k="Giới hạn">{p.defaults?.timeout_ms ? fmtDuration(p.defaults.timeout_ms) : '—'}</Kv>
        </div>
      </div>

      <div className="tbl-wrap">
        <table className="steps-tbl">
          <thead>
            <tr>
              <th>#</th>
              <th>Bước</th>
              <th>Cổng</th>
              <th>Chi phí</th>
              <th>Kiểm tra</th>
              <th>Đầu ra</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s, i) => (
              <tr key={s.key}>
                <td className="num dim">{two(i + 1)}</td>
                <td>
                  <b>{s.name}</b>
                  <div className="mono dim small">
                    {s.key}
                    {s.manual ? ' · việc tay' : ''}
                    {s.timeout_ms && s.timeout_ms !== p.defaults?.timeout_ms ? ` · ${fmtDuration(s.timeout_ms)}` : ''}
                  </div>
                </td>
                <td>{s.manual ? 'Việc tay' : gateLabel(s.gate)}</td>
                <td className={s.cost ? 'paid' : 'dim'}>{costText(s.cost)}</td>
                <td>
                  {s.checks?.length
                    ? s.checks.map((c) => (
                        <div key={c.name} title={c.run}>
                          {c.name}
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
          <pre className="box-pre">{p.yaml || '(trống)'}</pre>
        </details>
      </details>
    </section>
  );
}

// Gợi ý theo định dạng: xem trước, tùy chỉnh các bước rồi lưu thành quy trình của tôi.
function Suggest({ onSaved }) {
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
      toast(`Đã lưu quy trình "${r.name}".`, 'ok');
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
      <SkZone className="card sg" label="Đang tải gợi ý">
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
    <form className="card sg" onSubmit={save} noValidate aria-label="Gợi ý quy trình">
      <div className="sg-fmt">
        <FormatPicker catalog={catalog} value={format} onChange={setFormat} onValidity={setFormatOk} disabled={busy} />
      </div>
      <div className="sg-main">
        {sugg.error ? <div className="err-note" role="alert">{sugg.error.message}</div> : null}
        {draft ? (
          <>
            <div className="bp-h">
              <h2>{draft.name}</h2>
              <span className="muted">
                {enabled.length} bước{paid ? ` · ${paid} tốn tiền (luôn hỏi trước)` : ''}
                {sugg.loading ? <span className="spinner" aria-hidden="true" /> : null}
              </span>
            </div>
            <Flow steps={flowSteps(draft.steps)} staticMode label={`Các bước của ${draft.name}`} />
            <details className="bp-more">
              <summary>Tùy chỉnh các bước</summary>
              <StepEditor key={draft.id} steps={draft.steps} library={catalog.steps} onChange={(steps) => setDraft((d) => ({ ...d, steps }))} disabled={busy} />
            </details>
            <div className="sg-save">
              <input type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Tên quy trình" aria-label="Tên quy trình" disabled={busy} />
              <button type="submit" className="btn primary" disabled={!canSave}>
                {busy ? <span className="spinner" aria-hidden="true" /> : null}Lưu làm quy trình của tôi
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
          <SkZone className="sk-col" label="Đang tải gợi ý">
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

// Trang Quy trình: gợi ý, quy trình đã lưu, lỗi file YAML, nút tải lại.
export default function Pipelines({ data, error, channels = [], onReload }) {
  const toast = useToast();
  const presets = data?.presets || [];
  const errors = data?.errors || [];
  const chName = (id) => channels.find((c) => c.id === id)?.name;
  const [del, setDel] = useState(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState(null);

  const doDelete = async () => {
    setDelBusy(true);
    setDelErr(null);
    try {
      await api.deletePipeline(del.id);
      toast(`Đã xóa quy trình "${del.name}".`, 'ok');
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
        <h1>Quy trình</h1>
      </div>
      <h2 className="sec-h">Gợi ý</h2>
      <Suggest onSaved={onReload} />

      <div className="page-h sec">
        <h2 className="sec-h">Quy trình của tôi</h2>
        <button type="button" className="btn sm" onClick={onReload} title="Đọc lại các file YAML">
          Tải lại
        </button>
      </div>
      {error ? (
        <div className="err-note" role="alert">
          Không tải được quy trình: {error.message}
        </div>
      ) : null}
      {errors.length ? <PresetErrors errors={errors} /> : null}
      {!data && !error ? (
        <SkZone className="bp-list" label="Đang tải quy trình">
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
        <div className="card empty">Chưa có quy trình nào. Chọn định dạng ở trên, tùy chỉnh rồi bấm Lưu.</div>
      ) : null}
      <div className="bp-list">
        {presets.map((p) => (
          <PresetCard key={p.id} p={p} channelName={chName(p.channel)} onDelete={p.mine ? () => setDel(p) : null} />
        ))}
      </div>
      {del ? (
        <Modal title="Xóa quy trình?" onClose={() => setDel(null)} busy={delBusy}>
          <p className="note">
            Xóa <b>{del.name}</b>. Dự án đã tạo từ quy trình này không bị ảnh hưởng.
          </p>
          {delErr ? <div className="err-note" role="alert">{delErr}</div> : null}
          <div className="modal-acts">
            <button type="button" className="btn" onClick={() => setDel(null)} disabled={delBusy}>
              Hủy
            </button>
            <button type="button" className="btn danger" onClick={doDelete} disabled={delBusy}>
              {delBusy ? <span className="spinner" aria-hidden="true" /> : null}Xóa
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
