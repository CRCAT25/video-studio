// Trang Preset: mỗi preset một thẻ gọn (tên, sơ đồ bước); "Chi tiết" mở quyền, mặc định, bảng bước và YAML.
import Flow from '../components/Flow.jsx';
import { PresetErrors } from '../components/NewProjectModal.jsx';
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

function costText(c) {
  if (!c) return '—';
  const est = c.estimate != null && c.estimate !== '' ? ` · ${c.estimate}` : '';
  return `${c.service || 'dịch vụ'}${est}${c.always_ask ? ' · luôn hỏi' : ''}`;
}

// Thẻ một preset.
function PresetCard({ p, channelName }) {
  const steps = p.steps || [];
  const perms = p.permissions || {};
  const vars = p.vars && typeof p.vars === 'object' ? Object.entries(p.vars) : [];
  const paidCount = steps.filter((s) => s.cost).length;
  return (
    <section className="bp card" aria-label={`Preset ${p.name}`}>
      <div className="bp-h">
        <h2>{p.name}</h2>
        <span className="muted">
          <span className="mono" title={p.file || ''}>{p.id}</span> · {steps.length} bước{paidCount ? ` · ${paidCount} tốn tiền` : ''}
        </span>
      </div>
      <Flow steps={steps} staticMode label={`Các bước của preset ${p.name}`} />

      <details className="bp-more">
        <summary>Chi tiết</summary>
      <div className="spec">
        <div className="blk">
          <h3>Thông tin</h3>
          <Kv k="Kênh">{channelName || p.channel || '—'}</Kv>
          <Kv k="Định dạng">{p.format || '—'}</Kv>
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

// Trang Preset: danh sách bản vẽ, lỗi preset, nút tải lại YAML.
export default function Presets({ data, error, channels = [], onReload }) {
  const presets = data?.presets || [];
  const errors = data?.errors || [];
  const chName = (id) => channels.find((c) => c.id === id)?.name;
  return (
    <>
      <div className="page-h">
        <h1>Preset</h1>
        <button type="button" className="btn" onClick={onReload} title="Đọc lại file YAML trong thư mục presets/">
          Tải lại
        </button>
      </div>
      {error ? (
        <div className="err-note" role="alert">
          Không tải được preset: {error.message}
        </div>
      ) : null}
      {errors.length ? <PresetErrors errors={errors} /> : null}
      {!data && !error ? (
        <div className="empty">
          <span className="spinner" aria-hidden="true" /> Đang tải…
        </div>
      ) : null}
      {data && !presets.length ? (
        <div className="card empty">
          Chưa có preset. Thêm file <span className="mono">.yaml</span> vào thư mục <span className="mono">presets/</span> rồi bấm Tải lại.
        </div>
      ) : null}
      <div className="bp-list">
        {presets.map((p) => (
          <PresetCard key={p.id} p={p} channelName={chName(p.channel)} />
        ))}
      </div>
    </>
  );
}
