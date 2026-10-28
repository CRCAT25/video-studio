// Tổng quan: số liệu nhanh, việc đang chờ bạn (nếu có) và danh sách dự án kèm sơ đồ bước.
import { useMemo, useState } from 'react';
import Flow from '../components/Flow.jsx';
import NewProjectModal from '../components/NewProjectModal.jsx';
import { Sk, SkFlow, SkZone } from '../components/Skeleton.jsx';
import { useToast } from '../components/Toast.jsx';
import { useNow } from '../hooks/useNow.js';
import { LINE_CLASS, STATE_LABEL, fmtDateTime, fmtNum, fmtRelative, fmtTokens, fmtUsd, usageTokens } from '../lib/format.js';
import { navigate, stepHref } from '../lib/router.js';
import { T, tr, useT } from '../lib/i18n.jsx';

const WAIT_KIND = {
  needs_input: { cls: 'L-ask', label: T('Claude hỏi bạn') },
  failed: { cls: 'L-err', label: T('Bị lỗi') },
  manual: { cls: 'L-wait', label: T('Việc tay của bạn') },
};
const WAIT_ORDER = { needs_input: 0, failed: 1, manual: 2 };

// Một câu ngắn "đang làm gì" của dự án.
function nowText(p) {
  const c = p.current;
  if (p.status === 'done' || !c) return tr('Đã xong mọi bước.');
  const r = c.run;
  const at = `${c.name}`;
  switch (c.state) {
    case 'running': {
      const pct = r?.progress_pct != null ? ` · ${Math.round(Number(r.progress_pct))}%` : '';
      return `${at}: ${r?.progress_msg || tr('Claude đang làm…')}${pct}`;
    }
    case 'needs_input':
      return r?.summary ? tr('{at}: Claude cần bạn trả lời — {s}', { at, s: tr(r.summary) }) : tr('{at}: Claude cần bạn trả lời.', { at });
    case 'failed':
      const why = tr(r?.error || r?.summary || '');
      return why ? tr('{at}: lỗi — {s}', { at, s: why }) : tr('{at}: lỗi.', { at });
    case 'manual':
      return tr('{at}: việc tay — làm xong bấm "Đánh dấu xong".', { at });
    case 'stale':
      return tr('{at}: cần chạy lại vì bước trước vừa đổi.', { at });
    case 'ready':
      return r?.summary ? tr('{at}: sẵn sàng chạy. Lần trước: {s}', { at, s: tr(r.summary) }) : tr('{at}: sẵn sàng chạy.', { at });
    default:
      return `${at}: ${STATE_LABEL[c.state] || c.state}`;
  }
}

function lineState(p) {
  if (p.status === 'done') return { cls: 'L-ok', label: tr('Hoàn tất') };
  const st = p.current?.state;
  // đã xong vài bước, bước kế đang chờ chạy → dự án đang trong quá trình làm
  if ((st === 'ready' || st === 'pending') && (p.progress?.done || 0) > 0) return { cls: 'L-run', label: tr('Đang thực hiện') };
  return { cls: LINE_CLASS[st] || 'L-idle', label: STATE_LABEL[st] || tr('Chưa rõ') };
}

// Thẻ một dự án: tên, kênh/preset, trạng thái, tiến độ, sơ đồ bước, việc đang làm.
function ProjectLine({ p, now }) {
  const t = useT();
  const L = lineState(p);
  const target = p.current?.key || p.steps?.[0]?.key || '';
  const tokens = usageTokens(p.costs);
  const prog = p.progress || { done: 0, total: p.steps?.length || 0 };
  const href = stepHref(p.id, target);
  return (
    <article className={`card proj ${L.cls}`}>
      <div className="proj-h">
        <div className="ph">
          <a className="ptitle" href={href}>
            {p.title}
          </a>
          <span className="lst">
            <i className="lamp" />
            {L.label}
          </span>
        </div>
        <a className="btn sm" href={href} aria-label={t('Mở {n}', { n: p.title })}>
          {t('Mở')}
        </a>
      </div>
      <div className="proj-meta">
        <span>{p.channel?.name || p.channel?.id || t('Không kênh')} · {p.preset?.name || p.preset?.id}</span>
        <span>
          {t('{a}/{b} bước', { a: prog.done, b: prog.total })}
        </span>
        <span title={t('Cập nhật {at}', { at: fmtDateTime(p.updated_at) })}>{fmtRelative(p.updated_at, now)}</span>
        <span title={t('{n} lượt chạy', { n: fmtNum(p.costs?.runs ?? 0) })}>
          {fmtTokens(tokens)} {t('token')}
          {p.costs?.usd != null && Number(p.costs.usd) > 0 ? ` · ${fmtUsd(p.costs.usd)}` : ''}
        </span>
      </div>
      <Flow steps={p.steps || []} projectId={p.id} currentKey={p.current?.key} label={t('Các bước của {n}', { n: p.title })} />
      <p className="proj-now">{nowText(p)}</p>
    </article>
  );
}

function waitItems(projects) {
  const out = [];
  for (const p of projects) {
    for (const s of p.steps || []) {
      if (!WAIT_KIND[s.state]) continue;
      out.push({ p, s, at: s.run?.ended_at || p.updated_at });
    }
  }
  out.sort((a, b) => WAIT_ORDER[a.s.state] - WAIT_ORDER[b.s.state] || String(b.at || '').localeCompare(String(a.at || '')));
  return out;
}

// Danh sách bước đang chờ bạn (chỉ hiện khi có).
function WaitPanel({ items, now }) {
  const t = useT();
  return (
    <section className="card alarm" aria-label={t('Chờ bạn')}>
      <div className="bar-h">
        <h2 style={{ margin: 0 }}>
          {t('Chờ bạn')} <span className="cnt">{items.length}</span>
        </h2>
      </div>
      {items.slice(0, 30).map(({ p, s, at }) => {
        const k = WAIT_KIND[s.state];
        const msg = s.state === 'failed' ? tr(s.run?.error || s.run?.summary || '') : s.state === 'manual' ? t('Làm xong thì bấm "Đánh dấu xong".') : tr(s.run?.summary || '');
        return (
          <a key={`${p.id}/${s.key}`} className={`wait-item ${k.cls}`} href={stepHref(p.id, s.key)}>
            <i className="lamp" />
            <div className="wi-main">
              <div className="wi-t">
                <b>{tr(s.name)}</b> <span className="muted">· {p.title}</span>
              </div>
              {msg ? <p>{msg}</p> : null}
            </div>
            <span className="kind">{t(k.label)}</span>
            <span className="age">{fmtRelative(at, now)}</span>
          </a>
        );
      })}
    </section>
  );
}

// Khung chờ Tổng quan: 3 ô số + vài hàng dự án (tên, trạng thái, meta, dải bước).
function OverviewSkeleton() {
  const t = useT();
  return (
    <SkZone label={t('Đang tải dự án')}>
      <div className="stats">
        {['5em', '4em', '6em', '7em'].map((w) => (
          <div key={w} className="card stat">
            <span className="lbl">
              <Sk w={w} />
            </span>
            <span className="num">
              <Sk w="1.5em" />
            </span>
          </div>
        ))}
      </div>
      <div className="proj-list">
        {[0, 1, 2].map((i) => (
          <div key={i} className="card proj">
            <div className="proj-h">
              <div className="ph">
                <span className="ptitle">
                  <Sk w={['14em', '10em', '12em'][i]} />
                </span>
              </div>
              <Sk block w={52} h={28} />
            </div>
            <div className="proj-meta">
              <Sk w="8em" />
              <Sk w="6em" />
            </div>
            <SkFlow n={7} />
            <p className="proj-now">
              <Sk w="16em" />
            </p>
          </div>
        ))}
      </div>
    </SkZone>
  );
}

function StatCards({ stats, projects }) {
  const t = useT();
  const st = stats || {};
  const waitBy = { needs_input: 0, failed: 0, manual: 0 };
  for (const p of projects) for (const s of p.steps || []) if (s.state in waitBy) waitBy[s.state] += 1;
  const runningLines = projects.filter((p) => p.running_run_id || p.current?.state === 'running').length;
  const waiting = st.waiting ?? waitBy.needs_input + waitBy.failed + waitBy.manual;
  const unfinished = projects.filter((p) => p.status !== 'done').length;
  return (
    <div className="stats">
      <div className="card stat">
        <span className="lbl">{t('Chưa hoàn thành')}</span>
        <span className="num">{fmtNum(unfinished)}</span>
      </div>
      <div className="card stat">
        <span className="lbl">{t('Đang chạy')}</span>
        <span className="num">{fmtNum(st.running ?? runningLines)}</span>
      </div>
      <div className={`card stat${waiting > 0 ? ' hot' : ''}`}>
        <span className="lbl">{t('Chờ bạn')}</span>
        <span className="num">{fmtNum(waiting)}</span>
      </div>
      <div className="card stat">
        <span className="lbl">{t('Token tháng này')}</span>
        <span className="num" title={`${fmtNum(st.tokens_month ?? 0)} ${t('token')}`}>
          {fmtTokens(st.tokens_month ?? 0)}
        </span>
      </div>
    </div>
  );
}

// Trang Tổng quan; data = {projects, stats} từ GET /api/projects.
export default function Overview({ data, error, doctor, presetsData, channels, onReloadPresets, onReload }) {
  const t = useT();
  const now = useNow(30000);
  const toast = useToast();
  const [showNew, setShowNew] = useState(false);
  const [filter, setFilter] = useState('all');
  const projects = useMemo(() => data?.projects || [], [data]);
  const waits = useMemo(() => waitItems(projects), [projects]);

  const chans = useMemo(() => {
    const m = new Map();
    for (const p of projects) {
      const id = p.channel?.id || '';
      if (!m.has(id)) m.set(id, { id, name: p.channel?.name || id || t('Không kênh'), n: 0 });
      m.get(id).n += 1;
    }
    return [...m.values()];
  }, [projects, t]);
  const shown = filter === 'all' ? projects : projects.filter((p) => (p.channel?.id || '') === filter);

  const openNew = () => {
    onReloadPresets?.();
    setShowNew(true);
  };

  return (
    <>
      <div className="page-h">
        <h1>{t('Các dự án')}</h1>
        <button type="button" className="btn primary" onClick={openNew}>
          {t('+ Dự án mới')}
        </button>
      </div>

      {error && !data ? (
        <div className="err-note" role="alert">
          {error.message}{' '}
          <button type="button" className="linkbtn" onClick={onReload}>
            {t('Thử lại')}
          </button>
        </div>
      ) : null}

      {!data && !error ? <OverviewSkeleton /> : null}

      {data ? (
        <>
          <StatCards stats={data.stats} projects={projects} />
          {waits.length ? <WaitPanel items={waits} now={now} /> : null}
          {projects.length === 0 ? (
            <div className="card empty">
              {t('Chưa có dự án nào.')}
              <br />
              <button type="button" className="btn primary" onClick={openNew}>
                {t('+ Dự án mới')}
              </button>
            </div>
          ) : (
            <section aria-label={t('Danh sách dự án')}>
              {chans.length > 1 ? (
                <div className="chips" role="group" aria-label={t('Lọc theo kênh')}>
                  <button type="button" className={`chip${filter === 'all' ? ' on' : ''}`} onClick={() => setFilter('all')} aria-pressed={filter === 'all'}>
                    {t('Tất cả')}<span className="n">{projects.length}</span>
                  </button>
                  {chans.map((c) => (
                    <button key={c.id} type="button" className={`chip${filter === c.id ? ' on' : ''}`} onClick={() => setFilter(c.id)} aria-pressed={filter === c.id}>
                      {c.name}
                      <span className="n">{c.n}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="proj-list">
                {shown.map((p) => (
                  <ProjectLine key={p.id} p={p} now={now} />
                ))}
              </div>
              {shown.length === 0 ? <div className="empty">{t('Không có dự án nào của kênh này.')}</div> : null}
            </section>
          )}
        </>
      ) : null}

      {showNew ? (
        <NewProjectModal
          presetsData={presetsData}
          channels={channels}
          doctor={doctor}
          onClose={() => setShowNew(false)}
          onCreated={(view) => {
            setShowNew(false);
            toast(t('Đã tạo dự án "{n}".', { n: view?.title || view?.id }), 'ok');
            onReload?.();
            const first = view?.current?.key || view?.steps?.[0]?.key || '';
            navigate(stepHref(view.id, first));
          }}
        />
      ) : null}
    </>
  );
}
