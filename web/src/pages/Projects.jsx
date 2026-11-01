// Danh sách dự án: mỗi dự án một hàng gọn (tiến độ, trạng thái, bước hiện tại, token), tìm theo tên, lọc trạng thái, sắp xếp.
import { useMemo, useState } from 'react';
import DeleteProjectModal from '../components/DeleteProjectModal.jsx';
import NewProjectModal from '../components/NewProjectModal.jsx';
import RowMenu from '../components/RowMenu.jsx';
import Select from '../components/Select.jsx';
import { Sk, SkZone } from '../components/Skeleton.jsx';
import { useToast } from '../components/Toast.jsx';
import { useNow } from '../hooks/useNow.js';
import { fmtDateTime, fmtNum, fmtRelative, fmtTokens, fmtUsd, usageTokens } from '../lib/format.js';
import { intlLocale, T, tr, useT } from '../lib/i18n.jsx';
import { navigate, stepHref } from '../lib/router.js';
import { lineState } from './Overview.jsx';

const VIEW_KEY = 'vs-projects-view';
const WAIT_STATES = new Set(['needs_input', 'failed', 'manual', 'stale']);

// Nhóm lọc theo trạng thái (khớp nhãn trên chip của Tổng quan).
const GROUPS = [
  { value: 'all', label: T('Tất cả') },
  { value: 'active', label: T('Đang thực hiện') },
  { value: 'new', label: T('Chưa bắt đầu') },
  { value: 'running', label: T('Đang chạy') },
  { value: 'wait', label: T('Chờ bạn') },
  { value: 'done', label: T('Hoàn tất') },
];
const SORTS = [
  { value: 'updated', label: T('Mới cập nhật') },
  { value: 'name', label: T('Tên A–Z') },
  { value: 'progress', label: T('Tiến độ') },
];

// Nhóm trạng thái của một dự án.
function groupOf(p) {
  if (p.status === 'done') return 'done';
  const st = p.current?.state;
  if (p.status === 'running' || st === 'running') return 'running';
  if (WAIT_STATES.has(st)) return 'wait';
  return (p.progress?.done || 0) > 0 ? 'active' : 'new';
}

const ratio = (p) => (p.progress?.total ? p.progress.done / p.progress.total : 0);

// Đọc/lưu lựa chọn lọc + sắp xếp (trình duyệt chặn lưu thì dùng mặc định).
function loadView() {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
    return {
      status: GROUPS.some((g) => g.value === v.status) ? v.status : 'all',
      sort: SORTS.some((s) => s.value === v.sort) ? v.sort : 'updated',
    };
  } catch {
    return { status: 'all', sort: 'updated' };
  }
}
function saveView(v) {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(v));
  } catch {
    /* không lưu được thì thôi */
  }
}

// Khung chờ: thanh công cụ + vài hàng bảng.
function ProjectsSkeleton() {
  const t = useT();
  return (
    <SkZone label={t('Đang tải dự án')}>
      <div className="pl-bar">
        <Sk block className="pl-q" h={34} />
        <Sk block w={180} h={34} />
        <Sk block w={160} h={34} />
      </div>
      <div className="tbl-wrap pl-wrap">
        <table className="yt-tbl pl-tbl">
          <tbody>
            {['14em', '10em', '12em', '9em'].map((w) => (
              <tr key={w}>
                <td>
                  <span className="pl-name">
                    <Sk w={w} />
                  </span>
                </td>
                <td className="pl-m">
                  <Sk w="8em" />
                </td>
                <td className="pl-s">
                  <Sk w="5em" />
                </td>
                <td className="pl-s">
                  <Sk w="6em" />
                </td>
                <td className="pl-m">
                  <Sk w="7em" />
                </td>
                <td className="num pl-m">
                  <Sk w="3em" />
                </td>
                <td className="pl-s">
                  <Sk w="5em" />
                </td>
                <td className="pl-act">
                  <Sk block w={96} h={28} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SkZone>
  );
}

// Một hàng dự án.
function ProjectRow({ p, now, onDelete }) {
  const t = useT();
  const L = lineState(p);
  const target = p.current?.key || p.steps?.[0]?.key || '';
  const href = stepHref(p.id, target);
  const prog = p.progress || { done: 0, total: p.steps?.length || 0 };
  const pct = Math.round(ratio(p) * 100);
  const tokens = usageTokens(p.costs);
  const chan = `${p.channel?.name || p.channel?.id || t('Không kênh')} · ${p.preset?.name || p.preset?.id}`;
  const step = p.status === 'done' || !p.current ? '—' : tr(p.current.name);
  const status = (
    <span className="lst">
      <i className="lamp" />
      {L.label}
    </span>
  );
  const steps = t('{a}/{b} bước', { a: prog.done, b: prog.total });
  const upd = <span title={t('Cập nhật {at}', { at: fmtDateTime(p.updated_at) })}>{fmtRelative(p.updated_at, now)}</span>;
  return (
    <tr className={L.cls}>
      <td>
        <a className="pl-name" href={href}>
          {p.title}
        </a>
        {/* màn hẹp: gộp các cột bị ẩn vào dòng phụ */}
        <span className="pl-sub">
          <span className="pl-s-only">{status}</span>
          <span>{chan}</span>
          <span className="pl-s-only">{steps}</span>
          <span className="pl-s-only">{upd}</span>
        </span>
      </td>
      <td className="pl-m muted">{chan}</td>
      <td className="pl-s">
        <span className="pl-prog">
          <span>{steps}</span>
          <span className="quota-bar" role="progressbar" aria-label={steps} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span style={{ width: `${pct}%` }} />
          </span>
        </span>
      </td>
      <td className="pl-s">{status}</td>
      <td className="pl-m">{step}</td>
      <td className="num pl-m" title={t('{n} lượt chạy', { n: fmtNum(p.costs?.runs ?? 0) })}>
        {fmtTokens(tokens)}
        {p.costs?.usd != null && Number(p.costs.usd) > 0 ? ` · ${fmtUsd(p.costs.usd)}` : ''}
      </td>
      <td className="pl-s nowrap muted">{upd}</td>
      <td className="pl-act">
        <RowMenu
          label={t('Thao tác với dự án {n}', { n: p.title })}
          items={[
            { label: t('Mở'), onClick: () => navigate(href) },
            { sep: true },
            { label: t('Xóa'), onClick: () => onDelete(p), danger: true, disabled: p.status === 'running', title: p.status === 'running' ? t('Dự án đang chạy — dừng lượt đó trước khi xóa.') : undefined },
          ]}
        />
      </td>
    </tr>
  );
}

// Trang Danh sách dự án; data = {projects, stats} từ GET /api/projects (App tải lại theo SSE 'change').
export default function Projects({ data, error, doctor, presetsData, channels, onReloadPresets, onReload }) {
  const t = useT();
  const now = useNow(30000);
  const toast = useToast();
  const [showNew, setShowNew] = useState(false);
  const [del, setDel] = useState(null);
  const [q, setQ] = useState('');
  const [view, setView] = useState(loadView);
  const projects = useMemo(() => data?.projects || [], [data]);

  const pickView = (patch) => {
    const v = { ...view, ...patch };
    setView(v);
    saveView(v);
  };
  const clearFilters = () => {
    setQ('');
    pickView({ status: 'all' });
  };

  const counts = useMemo(() => {
    const c = { all: projects.length };
    for (const p of projects) {
      const g = groupOf(p);
      c[g] = (c[g] || 0) + 1;
    }
    return c;
  }, [projects]);

  const rows = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase(intlLocale());
    const list = projects.filter((p) => (view.status === 'all' || groupOf(p) === view.status) && (!needle || String(p.title || '').toLocaleLowerCase(intlLocale()).includes(needle)));
    const byName = (a, b) => String(a.title || '').localeCompare(String(b.title || ''), intlLocale());
    const byUpd = (a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    if (view.sort === 'name') return list.sort(byName);
    if (view.sort === 'progress') return list.sort((a, b) => ratio(b) - ratio(a) || byUpd(a, b));
    return list.sort(byUpd);
  }, [projects, q, view]);

  const openNew = () => {
    onReloadPresets?.();
    setShowNew(true);
  };

  return (
    <>
      <div className="page-h" data-ai-help="projects">
        <h1>{t('Danh sách dự án')}</h1>
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

      {!data && !error ? <ProjectsSkeleton /> : null}

      {data && projects.length === 0 ? (
        <div className="card empty">
          {t('Chưa có dự án nào.')}
          <br />
          <button type="button" className="btn primary" onClick={openNew}>
            {t('+ Dự án mới')}
          </button>
        </div>
      ) : null}

      {data && projects.length > 0 ? (
        <section aria-label={t('Danh sách dự án')}>
          <div className="pl-bar">
            <input type="search" className="pl-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Tìm theo tên dự án…')} aria-label={t('Tìm theo tên dự án')} />
            <Select
              className="pl-sel"
              label={t('Lọc theo trạng thái')}
              value={view.status}
              options={GROUPS.map((g) => ({ value: g.value, label: t(g.label), meta: fmtNum(counts[g.value] || 0) }))}
              onChange={(v) => pickView({ status: v })}
            />
            <Select className="pl-sel" label={t('Sắp xếp')} value={view.sort} options={SORTS.map((s) => ({ value: s.value, label: t(s.label) }))} onChange={(v) => pickView({ sort: v })} display={t('Sắp xếp: {s}', { s: t(SORTS.find((s) => s.value === view.sort).label) })} />
          </div>
          {rows.length ? (
            <div className="tbl-wrap pl-wrap">
              <table className="yt-tbl pl-tbl">
                <thead>
                  <tr>
                    <th>{t('Dự án')}</th>
                    <th className="pl-m">{t('Kênh · Quy trình')}</th>
                    <th className="pl-s">{t('Tiến độ')}</th>
                    <th className="pl-s">{t('Trạng thái')}</th>
                    <th className="pl-m">{t('Bước hiện tại')}</th>
                    <th className="num pl-m">{t('Token')}</th>
                    <th className="pl-s">{t('Cập nhật lúc')}</th>
                    <th>
                      <span className="sr-only">{t('Thao tác')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <ProjectRow key={p.id} p={p} now={now} onDelete={setDel} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card empty">
              {t('Không có dự án nào khớp bộ lọc.')}
              <br />
              <button type="button" className="btn" onClick={clearFilters}>
                {t('Xóa bộ lọc')}
              </button>
            </div>
          )}
        </section>
      ) : null}

      {del ? (
        <DeleteProjectModal
          p={del}
          onClose={() => setDel(null)}
          onDone={(r) => {
            toast(r.trashed ? t('Đã xóa dự án, thư mục nằm trong Thùng rác.') : t('Đã xóa dự án.'), 'ok');
            onReload?.();
          }}
        />
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
