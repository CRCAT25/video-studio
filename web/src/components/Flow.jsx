// Sơ đồ các bước: mỗi ô là một bước (số, tên, trạng thái), nối bằng mũi tên; chế độ cổng nằm trong tooltip.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { BOX_LABEL, GATE_SHORT, STATE_LABEL, fmtDuration, gateLabel, two } from '../lib/format.js';
import { stepHref } from '../lib/router.js';
import { tr, useT } from '../lib/i18n.jsx';

// Model mặc định cho bước chưa chọn riêng (của app, rồi của máy) — tải một lần, dùng chung cho mọi sơ đồ.
let defaultModelP = null;
function useDefaultModel(enabled) {
  const [m, setM] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    if (!defaultModelP) defaultModelP = api.defaultModel().then((r) => r.model || r.machine || '').catch(() => { defaultModelP = null; return ''; });
    let alive = true;
    defaultModelP.then((v) => alive && setM(v));
    return () => { alive = false; };
  }, [enabled]);
  return m;
}
const cap = (v) => (v ? v[0].toUpperCase() + v.slice(1) : v);

const DONEISH = new Set(['done', 'stale', 'needs_input', 'failed', 'manual', 'running']);

// Chuẩn hóa bước (StepSummary của dự án hoặc bước của preset) về một dạng chung.
function normalize(s, staticMode) {
  if (staticMode) {
    const cost = !!s.cost;
    return {
      key: s.key,
      name: s.name,
      cls: `s-plan${s.manual ? ' s-manual' : ''}`,
      // dạng ngắn để không bị cắt trong ô ('Tự · 30 phút')
      label: s.manual ? tr('Việc tay') : s.gate?.mode === 'auto_after' && s.gate?.after_ms ? tr('Tự · {d}', { d: fmtDuration(s.gate.after_ms) }) : GATE_SHORT[s.gate?.mode] || tr('Duyệt tay'),
      title: `${tr(s.name)} — ${s.manual ? tr('Việc tay của bạn') : gateLabel(s.gate)}${cost ? ` · ${tr('tốn tiền ({s})', { s: s.cost.service })}` : ''}`,
      cost,
      state: 'plan',
    };
  }
  const st = s.state || 'pending';
  return {
    key: s.key,
    name: s.name,
    cls: `s-${st}${s.manual && st !== 'manual' ? ' is-manual' : ''}`,
    label: BOX_LABEL[st] || STATE_LABEL[st] || st,
    title: `${tr(s.name)} — ${STATE_LABEL[st] || st} · ${tr('cổng')}: ${gateLabel({ mode: s.gate_mode || 'manual' })}${s.has_cost ? ` · ${tr('tốn tiền')}` : ''}${s.manual ? ` · ${tr('việc tay')}` : ''}`,
    cost: !!s.has_cost,
    state: st,
    model: s.model || '',
    unapproved: st === 'done' && s.approved === false,
    pct: st === 'running' ? s.run?.progress_pct : undefined,
  };
}

function edge(f) {
  if (!f) return;
  f.classList.toggle('fl', f.scrollLeft > 2);
  f.classList.toggle('fr', f.scrollLeft + f.clientWidth < f.scrollWidth - 2);
}

// Hiển thị sơ đồ; staticMode = bản xem preset (không link); large = sơ đồ ở trang bước.
// Dự án đã hiện sơ đồ lớn trong phiên này: lần sau (đổi bước) không chạy lại hiệu ứng trượt vào.
const shown = new Set();

export default function Flow({ steps = [], projectId, currentKey, large = false, staticMode = false, label }) {
  const ref = useRef(null);
  const t = useT();
  const items = steps.map((s) => normalize(s, staticMode));
  const defModel = useDefaultModel(!staticMode);
  const [calm] = useState(() => large && shown.has(projectId));
  useEffect(() => {
    if (large) shown.add(projectId);
  }, [large, projectId]);

  // Cuộn để bước hiện tại nằm giữa khung.
  useLayoutEffect(() => {
    const f = ref.current;
    if (!f) return;
    const c = f.querySelector('.box.cur');
    if (c) f.scrollLeft = c.offsetLeft - (f.clientWidth - c.offsetWidth) / 2;
    edge(f);
  }, [currentKey, steps.length]);

  useLayoutEffect(() => {
    edge(ref.current);
  });

  useLayoutEffect(() => {
    const f = ref.current;
    if (!f) return undefined;
    const onScroll = () => edge(f);
    f.addEventListener('scroll', onScroll, { passive: true });
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onScroll);
      ro.observe(f);
    }
    return () => {
      f.removeEventListener('scroll', onScroll);
      if (ro) ro.disconnect();
    };
  }, []);

  // Sơ đồ lớn: bước đã xong thu gọn thành một hàng nhãn nhỏ phía trên cho gọn; bước đang xem giữ nguyên chỗ, chỉ nhãn của nó mở rộng.
  const mini = large && !staticMode ? items.map((it, i) => ({ ...it, i })).filter((it) => it.state === 'done') : [];
  const miniKeys = new Set(mini.map((it) => it.key));

  return (
    <div ref={ref} className={`flow${large ? ' lg' : ''}${calm ? ' calm' : ''}${staticMode ? ' static' : ''}`} aria-label={label || t('Các bước')} tabIndex={staticMode ? -1 : undefined}>
      {mini.length ? (
        <div className="belt-mini">
          {mini.map((it) => {
            const cur = it.key === currentKey;
            return (
              <a key={it.key} className={`mini${it.unapproved ? ' unap' : ''}${cur ? ' cur' : ''}`} href={stepHref(projectId, it.key)} title={it.title} aria-current={cur ? 'step' : undefined} style={{ '--i': it.i }}>
                <span className="ck" aria-hidden="true">✓</span>
                <span className="no">{two(it.i + 1)}</span>
                <span className="nm">{tr(it.name)}</span>
                {cur && (it.model || defModel) ? <span className="mdl" title={t('Model dùng ở bước này')}>{cap(it.model || defModel)}</span> : null}
                {cur ? <span className="st">{it.label}</span> : null}
                {it.unapproved ? <em className="unap">{t('Chưa duyệt')}</em> : null}
              </a>
            );
          })}
        </div>
      ) : null}
      <div className="belt">
        {items.map((it, i) => {
          if (miniKeys.has(it.key)) return null;
          const Tag = staticMode ? 'div' : 'a';
          const linkProps = staticMode ? {} : { href: stepHref(projectId, it.key) };
          const cur = it.key === currentKey;
          const box = (
            <Tag key={it.key} className={`box ${it.cls}${cur ? ' cur' : ''}`} title={it.title} aria-current={cur ? 'step' : undefined} style={{ '--i': i }} {...linkProps}>
              <span className="no">
                {two(i + 1)}
                {it.cost ? (
                  <b className="tag-cost" title={t('Tốn tiền')}>
                    $
                  </b>
                ) : null}
                {staticMode ? null : <i className="lamp" />}
              </span>
              <span className="nm">{tr(it.name)}</span>
              <span className="ft">
                {staticMode || !(it.model || defModel) ? null : <span className="mdl" title={t('Model dùng ở bước này')}>{cap(it.model || defModel)}</span>}
                <span className="st">{it.label}{it.unapproved ? <em className="unap">{t('Chưa duyệt')}</em> : null}</span>
              </span>
              {it.state === 'running' ? (
                it.pct != null ? <i className="pg" style={{ width: `${Math.max(3, Math.min(100, Number(it.pct)))}%` }} /> : <i className="pg ind" />
              ) : null}
            </Tag>
          );
          if (i === items.length - 1) return box;
          const done = !staticMode && (it.state === 'done' || it.state === 'stale') && DONEISH.has(items[i + 1].state);
          return [box, <span key={`${it.key}-conn`} className={`conn${done ? ' done' : ''}`} aria-hidden="true" />];
        })}
      </div>
    </div>
  );
}
