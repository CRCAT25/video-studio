// Chọn định dạng video (hướng, tỷ lệ, độ dài, thời lượng) + hook lấy danh mục và quy trình gợi ý từ server.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Sk } from './Skeleton.jsx';
import { useT } from '../lib/i18n.jsx';

let catalogPromise = null;

// Danh mục định dạng (cache cả phiên; lỗi thì lần sau tải lại).
export function useCatalog() {
  const [state, setState] = useState({ catalog: null, error: null });
  useEffect(() => {
    let alive = true;
    catalogPromise ||= api.pipelineCatalog().catch((e) => {
      catalogPromise = null;
      throw e;
    });
    catalogPromise.then(
      (catalog) => alive && setState({ catalog, error: null }),
      (error) => alive && setState({ catalog: null, error }),
    );
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

export const DEFAULT_FORMAT = { orientation: 'vertical', aspect: '9:16', length: 'short', duration: 45, hd4k: false };

// Gợi ý chỉ phụ thuộc định dạng → cache cả phiên theo định dạng (promise; lỗi thì bỏ khỏi cache).
const suggestCache = new Map();
const SUGGEST_CACHE_MAX = 50;
const formatKey = (f) => [f.orientation, f.aspect, f.length, f.duration, f.hd4k ? 1 : 0].join('|');

function fetchSuggestion(format) {
  const key = formatKey(format);
  let p = suggestCache.get(key);
  if (!p) {
    p = api.suggestPipeline(format).then((r) => r.pipeline);
    p.catch(() => suggestCache.delete(key));
    if (suggestCache.size >= SUGGEST_CACHE_MAX) suggestCache.delete(suggestCache.keys().next().value);
    suggestCache.set(key, p);
  }
  return p;
}

// Tải sẵn gợi ý của độ dài còn lại (thời lượng mặc định) để bấm ngắn/dài hiện ngay.
function prefetchOtherLength(format) {
  catalogPromise?.then(
    (c) => {
      const other = c.lengths.find((l) => l.id !== format.length);
      if (other) fetchSuggestion({ ...format, length: other.id, duration: other.default }).catch(() => {});
    },
    () => {},
  );
}

// Quy trình gợi ý cho định dạng: có trong cache → hiện ngay; chưa có → chờ 200 ms sau lần đổi cuối rồi gọi API.
export function useSuggestion(format) {
  const [state, setState] = useState({ pipeline: null, error: null, loading: true });
  const key = formatKey(format);
  const fmtRef = useRef(format);
  fmtRef.current = format;
  useEffect(() => {
    let alive = true;
    const f = fmtRef.current;
    const load = () =>
      fetchSuggestion(f).then(
        // bản sao: sửa bước trong modal không đụng bản trong cache
        (pipeline) => {
          if (!alive) return;
          setState({ pipeline: structuredClone(pipeline), error: null, loading: false });
          prefetchOtherLength(f);
        },
        (error) => alive && setState({ pipeline: null, error, loading: false }),
      );
    let t = null;
    if (suggestCache.has(key)) load();
    else {
      setState((s) => ({ ...s, loading: true }));
      t = setTimeout(load, 200);
    }
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key]);
  return state;
}

// Bước trong YAML (id) → dạng Flow cần (key).
export const flowSteps = (steps = []) =>
  steps.filter((s) => s.enabled !== false).map((s) => ({ key: s.id, name: s.name, manual: !!s.manual, gate: s.gate, cost: s.cost || null }));

const ORIENT_ICON = { vertical: [12, 20], horizontal: [22, 13], square: [17, 17] };

function Frame({ w, h }) {
  return (
    <svg className="fmt-ic" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <rect x={(24 - w) / 2} y={(24 - h) / 2} width={w} height={h} rx="2.5" />
    </svg>
  );
}

// Thời lượng hiển thị theo đơn vị của độ dài: ngắn → giây, dài → phút.
const unitOf = (length) => (length === 'long' ? 60 : 1);

// Bộ chọn định dạng; value = {orientation, aspect, length, duration (giây), hd4k}; onValidity(ok) báo thời lượng nhập có hợp lệ.
export default function FormatPicker({ catalog, value, onChange, onValidity, disabled = false }) {
  const t = useT();
  const f = value;
  const orient = catalog.orientations.find((o) => o.id === f.orientation) || catalog.orientations[0];
  const aspects = orient.aspects.map((id) => catalog.aspects.find((a) => a.id === id)).filter(Boolean);
  const aspect = catalog.aspects.find((a) => a.id === f.aspect);
  const len = catalog.lengths.find((l) => l.id === f.length) || catalog.lengths[0];
  const unit = unitOf(len.id);
  const [durText, setDurText] = useState(String(f.duration / unit));
  useEffect(() => setDurText(String(f.duration / unit)), [f.duration, unit]);
  const durNum = Number(durText);
  const durBad = durText.trim() === '' || !Number.isInteger(durNum * unit) || durNum * unit < len.min || durNum * unit > len.max;
  useEffect(() => onValidity?.(!durBad), [durBad, onValidity]);

  const set = (patch) => onChange({ ...f, ...patch });
  const pickOrient = (o) => set({ orientation: o.id, aspect: o.aspects[0], hd4k: false });
  const pickLength = (l) => set({ length: l.id, duration: l.default });

  return (
    <div className="fmt">
      <div className="fmt-row">
        <span className="fld-l">{t('Khung hình')}</span>
        <div className="seg" role="radiogroup" aria-label={t('Khung hình')}>
          {catalog.orientations.map((o) => (
            <button key={o.id} type="button" role="radio" aria-checked={o.id === orient.id} className={o.id === orient.id ? 'on' : ''} onClick={() => pickOrient(o)} disabled={disabled}>
              <Frame w={ORIENT_ICON[o.id]?.[0] || 16} h={ORIENT_ICON[o.id]?.[1] || 16} />
              {t(o.label)}
            </button>
          ))}
        </div>
      </div>
      <div className="fmt-row">
        <span className="fld-l">{t('Tỷ lệ')}</span>
        <div className="seg" role="radiogroup" aria-label={t('Tỷ lệ')}>
          {aspects.map((a) => (
            <button key={a.id} type="button" role="radio" aria-checked={a.id === f.aspect} className={a.id === f.aspect ? 'on' : ''} onClick={() => set({ aspect: a.id, hd4k: false })} disabled={disabled}>
              {a.id}
            </button>
          ))}
        </div>
        {aspect ? (
          <span className="hint">
            {f.hd4k ? '3840×2160' : `${aspect.width}×${aspect.height}`} · {t(aspect.use)}
          </span>
        ) : null}
        {aspect?.hd4k ? (
          <label className="chk">
            <input type="checkbox" checked={!!f.hd4k} onChange={(e) => set({ hd4k: e.target.checked })} disabled={disabled} />
            <span>{t('Xuất 4K')}</span>
          </label>
        ) : null}
      </div>
      <div className="fmt-row">
        <span className="fld-l">{t('Độ dài')}</span>
        <div className="fmt-len" role="radiogroup" aria-label={t('Độ dài')}>
          {catalog.lengths.map((l) => {
            const u = unitOf(l.id);
            const range = u === 60 ? t('{a}–{b} phút', { a: l.min / 60, b: l.max / 60 }) : t('{a}–{b} giây', { a: l.min, b: l.max });
            return (
              <button key={l.id} type="button" role="radio" aria-checked={l.id === len.id} className={`fmt-card${l.id === len.id ? ' on' : ''}`} onClick={() => pickLength(l)} disabled={disabled}>
                <b>{t(l.label)}</b>
                <span>{range}</span>
              </button>
            );
          })}
        </div>
      </div>
      <label className="fmt-row fmt-dur">
        <span className="fld-l">{t('Thời lượng')}</span>
        <span className="fmt-dur-in">
          <input
            type="number"
            min={len.min / unit}
            max={len.max / unit}
            step="1"
            value={durText}
            disabled={disabled}
            aria-invalid={durBad}
            onChange={(e) => {
              setDurText(e.target.value);
              const n = Number(e.target.value) * unit;
              if (Number.isInteger(n) && n >= len.min && n <= len.max) set({ duration: n });
            }}
          />
          <span className="muted">{unit === 60 ? t('phút') : t('giây')}</span>
        </span>
        {durBad ? <span className="hint bad">{t('Từ {a} đến {b} {u}.', { a: len.min / unit, b: len.max / unit, u: unit === 60 ? t('phút') : t('giây') })}</span> : null}
      </label>
    </div>
  );
}

// Khung chờ bộ chọn định dạng khi danh mục chưa tải xong (nhãn là chữ cố định nên hiện luôn); người gọi bọc SkZone.
export function FormatPickerSkeleton() {
  const t = useT();
  return (
    <div className="fmt">
      <div className="fmt-row">
        <span className="fld-l">{t('Khung hình')}</span>
        <Sk block w={250} h={36} />
      </div>
      <div className="fmt-row">
        <span className="fld-l">{t('Tỷ lệ')}</span>
        <Sk block w={170} h={36} />
        <span className="hint">
          <Sk w="11em" />
        </span>
      </div>
      <div className="fmt-row">
        <span className="fld-l">{t('Độ dài')}</span>
        <div className="fmt-len">
          <Sk block h={64} />
          <Sk block h={64} />
        </div>
      </div>
      <div className="fmt-row">
        <span className="fld-l">{t('Thời lượng')}</span>
        <Sk block w={96} h={36} />
      </div>
    </div>
  );
}
