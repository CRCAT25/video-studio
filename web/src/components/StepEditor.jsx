// Sửa các bước của một quy trình: bật/tắt, đổi thứ tự, đổi tên, cổng duyệt, lời dặn Claude, đầu ra; thêm bước từ thư viện.
import { useState } from 'react';
import Select from './Select.jsx';
import Req from './Req.jsx';
import { T, tr, useT } from '../lib/i18n.jsx';

const GATES = [
  ['manual', T('Duyệt tay')],
  ['auto_if_checks', T('Tự duyệt khi kiểm đạt')],
];

// Bước chưa đủ để chạy (bước tự động cần lời dặn + đầu ra) → câu báo; đủ → null.
export function stepProblem(s) {
  if (s.enabled === false || s.manual) return null;
  if (!String(s.name || '').trim()) return tr('Cần tên bước.');
  if (!String(s.prompt || '').trim()) return tr('Cần lời dặn cho Claude.');
  if (!(s.outputs || []).length) return tr('Cần ít nhất 1 đầu ra.');
  return null;
}

// id mới không trùng: "buoc-moi", "buoc-moi-2"…
function freeId(steps, base) {
  const used = new Set(steps.map((s) => s.id));
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  return id;
}

export const MODELS = [
  ['', T('Mặc định của máy')],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
];

const outputsText = (o) => (o || []).join('\n');
const parseOutputs = (t) =>
  String(t)
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

function StepRow({ s, i, count, open, onToggleOpen, onChange, onMove, onRemove, disabled }) {
  const t = useT();
  const off = s.enabled === false;
  const problem = stepProblem(s);
  const gate = s.gate?.mode || (typeof s.gate === 'string' ? s.gate : 'manual');
  const [outs, setOuts] = useState(() => outputsText(s.outputs));
  return (
    <li className={`se-row${off ? ' off' : ''}${problem ? ' bad' : ''}`}>
      <div className="se-main">
        <input type="checkbox" checked={!off} onChange={(e) => onChange({ enabled: e.target.checked })} disabled={disabled} aria-label={t('Dùng bước {n}', { n: s.name })} />
        <span className="se-no">{String(i + 1).padStart(2, '0')}</span>
        <input type="text" className="se-name" value={s.name} maxLength={80} onChange={(e) => onChange({ name: e.target.value })} disabled={disabled || off} aria-label={t('Tên bước {n}', { n: i + 1 })} aria-required="true" />{off ? null : <Req />}
        <span className="se-tags">
          {s.cost ? <span className="tag paid" title={`${s.cost.service} · luôn hỏi trước khi tốn tiền`}>{t('Tốn tiền')}</span> : null}
          {s.manual ? <span className="tag">{t('Việc tay')}</span> : null}
        </span>
        {s.manual ? null : (
          <Select
            size="sm"
            className="se-gate"
            value={gate}
            options={[...GATES, ...(GATES.some(([v]) => v === gate) ? [] : [[gate, gate]])].map(([value, label]) => ({ value, label: t(label) }))}
            onChange={(mode) => onChange({ gate: { mode } })}
            disabled={disabled || off}
            label={t('Cổng duyệt bước {n}', { n: i + 1 })}
          />
        )}
        <span className="se-acts">
          <button type="button" className="btn sm ghost" onClick={() => onMove(-1)} disabled={disabled || i === 0} aria-label={t('Lên')} title={t('Lên')}>↑</button>
          <button type="button" className="btn sm ghost" onClick={() => onMove(1)} disabled={disabled || i === count - 1} aria-label={t('Xuống')} title={t('Xuống')}>↓</button>
          {s.manual ? null : (
            <button type="button" className={`btn sm ghost${open ? ' on' : ''}`} onClick={onToggleOpen} disabled={disabled} aria-expanded={open}>
              {t('Sửa')}
            </button>
          )}
          {onRemove ? (
            <button type="button" className="btn sm ghost" onClick={onRemove} disabled={disabled} aria-label={t('Bỏ bước')} title={t('Bỏ bước')}>✕</button>
          ) : null}
        </span>
      </div>
      {problem && !open ? <div className="hint bad se-hint">{problem}</div> : null}
      {open && !s.manual ? (
        <div className="se-edit">
          <label className="fld">
            <span>{t('Lời dặn Claude')}</span>
            <textarea rows={4} value={s.prompt || ''} onChange={(e) => onChange({ prompt: e.target.value })} disabled={disabled} />
            <span className="hint">
              {t('Dùng được')} <code>{'{title}'}</code>, <code>{'{feedback}'}</code>, <code>{'{vars.aspect}'}</code>, <code>{'{vars.duration_label}'}</code>.
            </span>
          </label>
          <label className="fld">
            <span>{t('Đầu ra')}</span>
            <textarea
              rows={2}
              className="mono-in"
              value={outs}
              onChange={(e) => {
                setOuts(e.target.value);
                onChange({ outputs: parseOutputs(e.target.value) });
              }}
              disabled={disabled}
            />
            <span className="hint">{t('Mỗi dòng một file hoặc mẫu, vd: script.md, images/*')}</span>
          </label>
          <label className="fld">
            <span>{t('Model của bước này')}</span>
            <Select
              size="sm"
              value={s.model || ''}
              options={[...MODELS, ...(!s.model || MODELS.some(([v]) => v === s.model) ? [] : [[s.model, s.model]])].map(([value, label]) => ({ value, label: t(label) }))}
              onChange={(model) => onChange({ model: model || undefined })}
              disabled={disabled}
              label={t('Model của bước này')}
            />
            <span className="hint">{t('Opus giỏi hơn nhưng tốn lượt dùng gói nhiều hơn.')}</span>
          </label>
          {problem ? <div className="hint bad">{problem}</div> : null}
        </div>
      ) : null}
    </li>
  );
}

// steps: mảng bước dạng YAML (id, name, prompt, outputs, gate, cost, manual, enabled); library: bước có thể thêm.
export default function StepEditor({ steps, library = [], onChange, disabled = false }) {
  const t = useT();
  const [openId, setOpenId] = useState(null);
  const [added, setAdded] = useState(() => new Set());
  const ids = new Set(steps.map((s) => s.id));
  const addable = library.filter((s) => !ids.has(s.id));

  const update = (i, patch) => onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i, d) => {
    const next = [...steps];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  const add = (val) => {
    if (!val) return;
    const lib = library.find((s) => s.id === val);
    const step = lib
      ? { ...JSON.parse(JSON.stringify(lib)), enabled: true }
      : { id: freeId(steps, 'buoc-moi'), name: t('Bước mới'), prompt: '', outputs: [], gate: { mode: 'manual' }, enabled: true };
    // bước tự thêm: chèn trước "Gói đăng" nếu có, để gói đăng luôn ở cuối
    const last = steps.length && steps[steps.length - 1].id === 'goi-dang' ? steps.length - 1 : steps.length;
    onChange([...steps.slice(0, last), step, ...steps.slice(last)]);
    setAdded((a) => new Set(a).add(step.id));
    if (!lib) setOpenId(step.id);
  };

  return (
    <div className="se">
      <ol className="se-list">
        {steps.map((s, i) => (
          <StepRow
            key={s.id}
            s={s}
            i={i}
            count={steps.length}
            open={openId === s.id}
            onToggleOpen={() => setOpenId(openId === s.id ? null : s.id)}
            onChange={(patch) => update(i, patch)}
            onMove={(d) => move(i, d)}
            onRemove={() => onChange(steps.filter((_, j) => j !== i))}
            disabled={disabled}
          />
        ))}
      </ol>
      <div className="se-add">
        {/* ô chọn kiểu menu: chọn xong thêm bước, ô quay về chữ "+ Thêm bước…" */}
        <Select
          size="sm"
          className="se-add-sel"
          value=""
          placeholder={t('+ Thêm bước…')}
          options={[...addable.map((s) => ({ value: s.id, label: s.name })), { value: '__custom', label: t('Bước tự viết') }]}
          onChange={add}
          disabled={disabled}
          label={t('Thêm bước')}
        />
      </div>
    </div>
  );
}
