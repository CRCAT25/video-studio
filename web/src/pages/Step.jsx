// Trang chi tiết bước: tiêu đề + nút theo §5, sơ đồ bước, tab Nhật ký/Đầu ra/Kiểm tra/Prompt/Chi tiết (các lượt, chi phí).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Select from '../components/Select.jsx';
import { MODELS, defaultModelLabel } from '../components/StepEditor.jsx';
import Flow from '../components/Flow.jsx';
import CostModal from '../components/CostModal.jsx';
import Modal from '../components/Modal.jsx';
import DistillModal from '../components/DistillModal.jsx';
import ProjectPipelineModal from '../components/ProjectPipelineModal.jsx';
import LogTerminal from '../components/LogTerminal.jsx';
import Outputs, { Checks } from '../components/Outputs.jsx';
import { Sk, SkFlow, SkLines, SkZone } from '../components/Skeleton.jsx';
import { useToast } from '../components/Toast.jsx';
import { useSSE, useSSEStatus } from '../hooks/useSSE.js';
import { useNow } from '../hooks/useNow.js';
import { copyText } from '../lib/clipboard.js';
import {
  RUN_LABEL,
  STATE_LABEL,
  fmtDateTime,
  fmtDuration,
  fmtElapsed,
  fmtNum,
  fmtTokens,
  fmtUsd,
  gateLabel,
  runElapsed,
  usageTokens,
} from '../lib/format.js';
import { grantRules, isOnceOnly } from '../lib/grant.js';
import { stepHref } from '../lib/router.js';
import { tr, useT } from '../lib/i18n.jsx';

const FEEDBACK_MAX = 20000;
const RUNNABLE = new Set(['ready', 'done', 'failed', 'needs_input', 'stale']);
const COMPLETABLE = new Set(['failed', 'needs_input', 'stale', 'manual']);

// Trang Chi tiết bước; thiếu stepKey thì chuyển tới bước hiện tại của dự án.
export default function Step({ projectId, stepKey }) {
  if (!stepKey) return <StepRedirect projectId={projectId} />;
  return <StepPage projectId={projectId} stepKey={stepKey} />;
}

function StepRedirect({ projectId }) {
  const t = useT();
  const [err, setErr] = useState(null);
  useEffect(() => {
    const ac = new AbortController();
    api
      .project(projectId, { signal: ac.signal })
      .then((p) => {
        const key = p?.current?.key || p?.steps?.[0]?.key;
        if (key) window.location.replace(stepHref(projectId, key));
        else setErr(new Error(t('Dự án chưa có bước nào.')));
      })
      .catch((e) => {
        if (e?.name !== 'AbortError') setErr(e);
      });
    return () => ac.abort();
  }, [projectId]);
  if (err) return <NotFound message={err.status === 404 ? t('Không tìm thấy dự án "{n}".', { n: projectId }) : err.message} />;
  return <StepSkeleton label={t('Đang mở dự án')} />;
}

// Khung chờ trang bước: đường dẫn, tiêu đề + thông số, dải bước lớn, tab, nội dung + cột phải.
function StepSkeleton({ label }) {
  return (
    <SkZone label={label}>
      <div className="crumb">
        <Sk w="16em" />
      </div>
      <div className="step-head">
        <div>
          <h1>
            <Sk w="9em" />
          </h1>
          <div className="meta">
            {['5em', '4em', '8em', '5em', '7em'].map((w, i) => (
              <span key={i} className="ro">
                <Sk w={w} />
              </span>
            ))}
          </div>
        </div>
        <div className="acts">
          <Sk block w={88} h={34} />
        </div>
      </div>
      <div className="line-panel">
        <SkFlow n={7} lg />
      </div>
      <div className="subtabs">
        {['4.5em', '4em', '4.5em', '3.5em'].map((w, i) => (
          <button key={i} type="button" tabIndex={-1} disabled>
            <Sk w={w} />
          </button>
        ))}
      </div>
      <div className="step-grid one">
        <Sk block h={477} />
      </div>
    </SkZone>
  );
}

function NotFound({ message }) {
  const t = useT();
  return (
    <div className="card pad empty">
      <b>{message}</b>
      <p className="note">
        <a href="#/">{t('Về Tổng quan')}</a>
      </p>
    </div>
  );
}

function denialText(d) {
  if (!d || typeof d !== 'object') return String(d ?? '');
  const tool = d.tool ?? d.tool_name ?? '?';
  const input = d.input ?? d.tool_input;
  let s = '';
  // Ưu tiên trường chính (lệnh, URL, file) cho dễ đọc; còn lại mới in JSON.
  const main = input && typeof input === 'object' ? ['command', 'url', 'file_path', 'path', 'pattern', 'query'].map((k) => input[k]).find((v) => typeof v === 'string' && v) : null;
  if (main) s = main;
  else if (input != null) {
    try {
      s = typeof input === 'string' ? input : JSON.stringify(input);
    } catch {
      s = String(input);
    }
  }
  if (s.length > 240) s = `${s.slice(0, 240)}…`;
  return s ? `${tool}: ${s}` : String(tool);
}

function runTokens(run, costs) {
  const u = usageTokens(run?.usage);
  if (u) return u;
  const c = (costs || []).filter((x) => x.kind === 'claude_tokens').reduce((a, x) => a + (Number(x.units) || 0), 0);
  return c || 0;
}

// Mỗi lần bị chặn có 3 nút: cho phép lần này (chạy lại bước, không lưu), trong dự án này, hoặc cho mọi dự án (ghi vào quy trình đã lưu).
function GrantBar({ denials, grant }) {
  const t = useT();
  const items = [];
  const seen = new Set();
  for (const d of denials) {
    const rules = grantRules(d);
    const key = rules.join('|');
    if (!rules.length || seen.has(key)) continue;
    seen.add(key);
    items.push(rules);
  }
  if (!grant || !items.length) return <p className="note">{t('Thêm quyền vào mục permissions của quy trình nếu bước thật sự cần.')}</p>;
  return (
    <div className="grant">
      {items.map((rules) => {
        const label = rules.join(', ');
        const done = rules.every((r) => grant.granted.has(r));
        const doneAll = rules.every((r) => grant.grantedAll.has(r));
        const off = !!grant.busy;
        const onceOnly = rules.some(isOnceOnly);
        return (
          <div className="grant-row" key={label}>
            <code className="grant-rule">{label}</code>
            <div className="grant-btns">
              <button type="button" className="btn sm" disabled={off || !grant.onOnce} onClick={() => grant.onOnce(rules)} title={t('Chạy lại bước với quyền này, không lưu lại')}>
                {t('Cho phép lần này')}
              </button>
              {onceOnly ? (
                <span className="note">{t('Lệnh find chỉ cho phép một lần (không lưu), vì quy tắc lưu sẽ cho cả -delete/-exec.')}</span>
              ) : (
                <>
              <button type="button" className="btn sm" disabled={off || done} onClick={() => grant.onGrant(rules, 'project')}>
                {done ? t('✓ Đã cho phép trong dự án') : t('Cho phép trong dự án này')}
              </button>
              <button type="button" className="btn sm" disabled={off || doneAll} onClick={() => grant.onGrant(rules, 'pipeline')} title={t('Ghi vào quy trình đã lưu để các dự án sau cũng được phép')}>
                {doneAll ? t('✓ Đã cho phép mọi dự án') : t('Cho phép tất cả các dự án')}
              </button>
                </>
              )}
            </div>
          </div>
        );
      })}
      {grant.granted.size && grant.onRerun ? (
        <button type="button" className="btn sm primary" disabled={!!grant.busy} onClick={grant.onRerun}>
          {t('Chạy lại bước')}
        </button>
      ) : null}
    </div>
  );
}

// Thân kết quả lượt: lỗi, tóm tắt, câu hỏi, ghi chú cho bước sau, các lần bị chặn quyền.
function ResultBody({ run, live = false, grant = null }) {
  const t = useT();
  const r = run.result || {};
  const questions = Array.isArray(r.questions) ? r.questions.filter(Boolean) : [];
  const denials = Array.isArray(run.denials) ? run.denials : [];
  const summary = tr(r.summary || run.summary || '') || null;
  return (
    <div className="result">
      {run.error ? <div className="err-note">{tr(run.error)}</div> : null}
      {summary ? <p>{summary}</p> : !live && !run.error ? <p className="muted">{t('Lượt này không có tóm tắt.')}</p> : null}
      {questions.length ? (
        <>
          <h3>{t('Claude hỏi')}</h3>
          <ul>
            {questions.map((q, i) => (
              <li key={i}>{String(q)}</li>
            ))}
          </ul>
        </>
      ) : null}
      {r.notes_for_next_step ? (
        <>
          <h3>{t('Ghi chú cho bước sau')}</h3>
          <p>{String(r.notes_for_next_step)}</p>
        </>
      ) : null}
      {denials.length ? (
        <>
          <h3>{t('Bị chặn quyền ({n})', { n: denials.length })}</h3>
          {denials.slice(0, 20).map((d, i) => (
            <div key={i} className="denial">
              ✕ {denialText(d)}
            </div>
          ))}
          <GrantBar denials={denials} grant={grant} />
        </>
      ) : null}
    </div>
  );
}

// Thẻ kết quả lượt (kèm thanh tiến độ khi đang chạy).
function ResultCard({ run, live, grant }) {
  const t = useT();
  if (!run) {
    return (
      <div className="card pad">
        <h2>{t('Kết quả')}</h2>
        <p className="muted small" style={{ margin: 0 }}>
          {t('Chưa chạy lượt nào.')}
        </p>
      </div>
    );
  }
  const pct = run.progress_pct != null ? Math.max(0, Math.min(100, Number(run.progress_pct))) : null;
  return (
    <div className="card pad">
      <h2>{t('Kết quả · lượt {n}', { n: run.n })}</h2>
      {live ? (
        <>
          <div className="bar" title={pct != null ? `${Math.round(pct)}%` : t('Đang chạy')}>
            <i style={{ width: `${pct != null ? Math.max(3, pct) : 100}%`, opacity: pct != null ? 1 : 0.5 }} />
          </div>
          <div className="prog-msg" style={{ marginBottom: 10 }}>
            {pct != null ? `${Math.round(pct)}% · ` : ''}
            {run.progress_msg || t('Claude đang làm…')}
          </div>
        </>
      ) : null}
      <ResultBody run={run} live={live} grant={grant} />
    </div>
  );
}

function StepPage({ projectId, stepKey }) {
  const t = useT();
  const toast = useToast();
  const [view, setView] = useState(null);
  const [err, setErr] = useState(null);
  const [selRunId, setSelRunId] = useState(null);
  const [rerunAsk, setRerunAsk] = useState(false); // hộp xác nhận trước khi Chạy lại một bước đã chạy
  const [tab, setTab] = useState(null);
  const [defModel, setDefModel] = useState(null); // model mặc định để ghi vào nhãn
  useEffect(() => {
    api.defaultModel().then(setDefModel).catch(() => {});
  }, []);
  const [pipeEdit, setPipeEdit] = useState(false); // hộp Sửa quy trình của dự án
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(null);
  const [costAsk, setCostAsk] = useState(null);
  const [distillOpen, setDistillOpen] = useState(false);
  const [actionErr, setActionErr] = useState(null);
  const [copied, setCopied] = useState(false);
  const [granted, setGranted] = useState(() => new Set());
  const [grantedAll, setGrantedAll] = useState(() => new Set());
  const [grantBusy, setGrantBusy] = useState(false);
    const reqRef = useRef(0);
  const timer = useRef(null);
  const copyTimer = useRef(null);
  const fbRef = useRef(null);

  const load = useCallback(async () => {
    reqRef.current += 1;
    const my = reqRef.current;
    try {
      const v = await api.step(projectId, stepKey);
      if (my !== reqRef.current) return;
      setView(v);
      setErr(null);
    } catch (e) {
      if (my !== reqRef.current) return;
      setErr(e);
    }
  }, [projectId, stepKey]);

  useEffect(() => {
    load();
  }, [load]);

  useSSE((msg) => {
    const hit = (msg.type === 'change' && (!msg.data?.projectId || msg.data.projectId === projectId)) || msg.type === 'reconnect';
    if (!hit) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(load, 150);
  });
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      clearTimeout(copyTimer.current);
    },
    [],
  );

  const project = view?.project;
  const step = view?.step;
  const runs = view?.runs || [];
  const latest = view?.latest || null;
  const selRun = (selRunId && runs.find((r) => r.id === selRunId)) || runs[0] || null;
  const isLatest = !!selRun && selRun.id === runs[0]?.id;
  const live = selRun?.state === 'running';
  // mất SSE → không giả vờ trực tiếp: dừng đồng hồ, nhật ký báo mất kết nối
  const offline = useSSEStatus() === 'reconnecting';
  const now = useNow(1000, live && !offline);

  // Tab mặc định: đang chạy → Nhật ký; có đầu ra → Đầu ra; còn lại → Nhật ký.
  useEffect(() => {
    if (tab || !view) return;
    if (view.step?.state !== 'running' && view.latest?.artifacts?.length) setTab('out');
    else setTab('log');
  }, [view, tab]);

  useEffect(() => {
    if (step && project) document.title = `${tr(step.name)} · ${project.title} · Video Studio`;
  }, [step?.name, project?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err && !view) {
    if (err.status === 404) return <NotFound message={err.message || t('Không tìm thấy bước này.')} />;
    return (
      <div className="card pad">
        <div className="err-note" role="alert">
          {t('Không tải được bước:')} {err.message}
        </div>
        <p className="note">
          <button type="button" className="linkbtn" onClick={load}>
            {t('Thử lại')}
          </button>{' '}
          · <a href="#/">{t('Về Tổng quan')}</a>
        </p>
      </div>
    );
  }
  if (!view || !step || !project) {
    return <StepSkeleton label={t('Đang tải bước')} />;
  }

  const st = step.state;
  const idx = (project.steps || []).findIndex((s) => s.key === step.key);
  const total = project.steps?.length || 0;
  const prevOk = (project.steps || []).slice(0, Math.max(0, idx)).every((s) => s.state === 'done' || s.state === 'stale');
  const canRun = view.can_run || { ok: false };
  const paid = !!(step.cost || step.has_cost);
  const fbTrim = feedback.trim();

  // Cho phép quy tắc bị chặn: thêm vào allow của dự án (scope 'pipeline' ghi thêm vào quy trình đã lưu), rồi gợi ý chạy lại.
  const onGrant = async (rules, scope) => {
    setGrantBusy(true);
    try {
      let saved = false;
      for (const rule of rules) {
        const r = await api.grantPermission(projectId, rule, scope);
        saved = saved || !!r.savedUpdated;
        setGranted((g) => new Set(g).add(rule));
        if (scope === 'pipeline' && r.savedUpdated) setGrantedAll((g) => new Set(g).add(rule));
      }
      toast(t('Đã cho phép {tools} — chạy lại bước để áp dụng.', { tools: rules.join(', ') }) + (scope === 'pipeline' && !saved ? ' ' + t('(Quy trình này chưa được lưu nên chỉ áp cho dự án.)') : ''), 'ok');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setGrantBusy(false);
    }
  };


  const doRun = async (fb, allowPaid = false, allowOnce = undefined) => {
    setBusy('run');
    setActionErr(null);
    try {
      await api.runStep(projectId, stepKey, { feedback: fb || undefined, allowPaid, allowOnce });
      setCostAsk(null);
      if (fb) setFeedback('');
      setSelRunId(null);
      setTab('log');
      toast(t('Đã bắt đầu chạy "{n}".', { n: step.name }), 'ok');
      await load();
    } catch (e) {
      if (e.status === 412) {
        setCostAsk({ cost: e.data?.cost || step.cost, feedback: fb, allowOnce });
      } else {
        setCostAsk(null);
        setActionErr(e.message);
        toast(e.message, 'err');
        load();
      }
    } finally {
      setBusy(null);
    }
  };

  // Bước tốn tiền → luôn mở modal xác nhận trước; Hủy không gọi API.
  const requestRun = (fb) => {
    if (paid) {
      setCostAsk({ cost: step.cost, feedback: fb });
      return;
    }
    doRun(fb, false);
  };

  const runWithFeedback = () => {
    if (!fbTrim) {
      fbRef.current?.focus();
      toast(t('Viết góp ý hoặc câu trả lời cho Claude trước đã.'), 'info');
      return;
    }
    requestRun(fbTrim);
  };

  const doStop = async () => {
    const rid = project.running_run_id || step.run?.id;
    if (!rid) return;
    setBusy('stop');
    setActionErr(null);
    try {
      await api.stopRun(rid);
      toast(t('Đã gửi lệnh dừng.'), 'info');
      await load();
    } catch (e) {
      setActionErr(e.message);
      toast(e.message, 'err');
    } finally {
      setBusy(null);
    }
  };

  const doApprove = async () => {
    setBusy('approve');
    setActionErr(null);
    try {
      const v = await api.approveStep(projectId, stepKey);
      if (v && v.step) setView(v);
      else await load();
      toast(t('Đã duyệt "{n}".', { n: step.name }), 'ok');
    } catch (e) {
      setActionErr(e.message);
      toast(e.message, 'err');
    } finally {
      setBusy(null);
    }
  };

  const doComplete = async () => {
    setBusy('complete');
    setActionErr(null);
    try {
      const v = await api.completeStep(projectId, stepKey);
      if (v && v.step) setView(v);
      else await load();
      toast(t('Đã đánh dấu xong "{n}".', { n: step.name }), 'ok');
    } catch (e) {
      setActionErr(e.message);
      toast(e.message, 'err');
    } finally {
      setBusy(null);
    }
  };

  const doCopy = async () => {
    if (!view.resume_cmd) return;
    const ok = await copyText(view.resume_cmd);
    if (ok) {
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
      toast(t('Đã chép lệnh — dán vào terminal để làm tiếp phiên này.'), 'ok');
    } else {
      toast(t('Không chép được vào clipboard — chọn lệnh ở cột bên rồi tự chép.'), 'err');
    }
  };

  // Nút chính theo trạng thái (§5).
  const runDisabled = !!busy || !canRun.ok;
  const runTitle = canRun.ok ? (paid ? t('Bước tốn tiền — sẽ hỏi xác nhận chi phí') : '') : canRun.message || t('Chưa chạy được');
  const buttons = [];
  if (st === 'running') {
    buttons.push(
      <button key="stop" type="button" className="btn danger" onClick={doStop} disabled={!!busy}>
        {busy === 'stop' ? <span className="spinner" aria-hidden="true" /> : null}{t('Dừng')}
      </button>,
    );
  } else if (st === 'needs_input') {
    buttons.push(
      <button key="fb" type="button" className={`btn ${paid ? 'paid' : 'primary'}`} onClick={runWithFeedback} disabled={runDisabled} title={runTitle}>
        {busy === 'run' ? <span className="spinner" aria-hidden="true" /> : paid ? '$ ' : ''}{t('Chạy lại kèm góp ý')}
      </button>,
    );
  } else if (RUNNABLE.has(st) && !step.manual) {
    buttons.push(
      <button key="run" type="button" className={`btn ${paid ? 'paid' : st === 'done' ? '' : 'primary'}`} onClick={() => (st === 'ready' ? requestRun('') : setRerunAsk(true))} disabled={runDisabled} title={runTitle}>
        {busy === 'run' ? <span className="spinner" aria-hidden="true" /> : null}
        {paid ? `$ ${st === 'ready' ? t('Chạy') : t('Chạy lại')}` : st === 'ready' ? t('Chạy') : t('Chạy lại')}
      </button>,
    );
  }
  if (COMPLETABLE.has(st)) {
    buttons.push(
      <button
        key="done"
        type="button"
        className={`btn${st === 'manual' ? ' primary' : ''}`}
        onClick={doComplete}
        disabled={!!busy || !prevOk}
        title={prevOk ? t('Đánh dấu bước này đã xong (bước sau sẽ sẵn sàng)') : t('Các bước trước phải xong trước')}
      >
        {busy === 'complete' ? <span className="spinner" aria-hidden="true" /> : null}{t('Đánh dấu xong')}
      </button>,
    );
  }
  const nextStep = idx >= 0 ? (project.steps || [])[idx + 1] : null;
  let nextBtn = null;
  if (st === 'done' && nextStep) {
    nextBtn = (
      <div key="next" className="tab-next-grp">
        {step.approved ? (
          <span className="approved-tag" title={t('Bạn đã duyệt kết quả bước này')}>{t('✓ Đã duyệt')}</span>
        ) : (
          <button type="button" className="btn primary" onClick={doApprove} disabled={!!busy} title={t('Xác nhận kết quả bước này ổn')}>
            {busy === 'approve' ? <span className="spinner" aria-hidden="true" /> : null}{t('Duyệt')}
          </button>
        )}
        <button type="button" className="btn" onClick={() => window.location.assign(stepHref(projectId, nextStep.key))} title={t('Mở bước "{n}"', { n: nextStep.name })}>
          {t('Sang bước tiếp →')}
        </button>
      </div>
    );
  }
  const doneUpto = (project.steps || []).slice(0, Math.max(0, idx) + 1).filter((x) => x.state === 'done').length;
  if (st === 'done' || doneUpto > 0) {
    buttons.push(
      <button key="distill" type="button" className="btn" onClick={() => setDistillOpen(true)} title={t('Claude đúc kết cách làm của bước này hoặc cả dự án thành skill cá nhân để dùng lại ở video sau')}>
        {t('Tạo skill')}
      </button>,
    );
  }
  buttons.push(
    <button
      key="term"
      type="button"
      className="btn"
      onClick={doCopy}
      disabled={!view.resume_cmd}
      title={view.resume_cmd ? t('Chép lệnh mở phiên Claude này trong terminal để làm tay') : t('Chưa có phiên Claude — chạy một bước trước đã')}
    >
      {copied ? t('Đã chép lệnh') : t('Mở trong terminal')}
    </button>,
  );

  const tokens = runTokens(selRun, isLatest ? latest?.costs : null);
  const byStep = (view.usage_by_step || []).map((x) => ({ ...x, total: usageTokens(x) }));
  const stepTotal = byStep.find((x) => x.key === step.key)?.total || 0;
  const curIdx = byStep.findIndex((x) => x.key === step.key);
  const uptoHere = byStep.slice(0, curIdx + 1).reduce((a, x) => a + x.total, 0);
  const projectTotal = byStep.reduce((a, x) => a + x.total, 0);
  const artifacts = isLatest ? latest?.artifacts || [] : selRun?.result?.artifacts || [];
  const checks = isLatest ? latest?.checks || [] : [];
  const curTab = tab || 'log';
  const costLine = step.cost
    ? `${step.cost.service || t('dịch vụ')}${step.cost.estimate_value != null ? ` · ~${fmtNum(step.cost.estimate_value)} ${step.cost.unit || ''}` : ''}`
    : null;
  const u = selRun?.usage || null;
  const showWarn = !canRun.ok && canRun.message && !step.manual && st !== 'running' && st !== 'pending';
  const decide = st === 'needs_input' && isLatest;
  const grant = isLatest && !live
    ? { granted, grantedAll, busy: grantBusy || busy, onGrant, onOnce: canRun.ok && RUNNABLE.has(st) ? (rules) => doRun(undefined, false, rules) : null, onRerun: canRun.ok && RUNNABLE.has(st) ? () => doRun(undefined) : null }
    : null;

  const feedbackBox = (
    <>
      <label className="sr-only" htmlFor="fb">
        {t('Góp ý cho lượt sau')}
      </label>
      <textarea
        id="fb"
        ref={fbRef}
        value={feedback}
        maxLength={FEEDBACK_MAX}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder={decide ? t('Trả lời Claude hoặc góp ý…') : t('Vd: đoạn mở đầu ngắn lại, giọng ấm hơn')}
      />
      <div className="acts" style={{ marginTop: 8, justifyContent: 'space-between' }}>
        <span className="num small dim">
          {fmtNum(feedback.length)}/{fmtNum(FEEDBACK_MAX)}
        </span>
        <button
          type="button"
          className={`btn sm ${paid ? 'paid' : 'primary'}`}
          onClick={runWithFeedback}
          disabled={!!busy || !fbTrim || !canRun.ok || st === 'running'}
          title={!canRun.ok ? canRun.message || '' : ''}
        >
          {paid ? '$ ' : ''}
          {runs.length ? t('Chạy lại kèm góp ý') : t('Chạy kèm góp ý')}
        </button>
      </div>
    </>
  );

  return (
    <>
      <div className="crumb">
        <a href="#/">{t('Tổng quan')}</a> <span className="sep">/</span> <span>{project.title}</span> <span className="sep">/</span> <span>{tr(step.name)}</span>
      </div>

      <div className="step-head">
        <div>
          <h1>
            {tr(step.name)}
            <span className={`state-tag s-${st}`}>
              {st === 'running' ? <span className="dot" /> : null}
              {STATE_LABEL[st] || st}
            </span>
            {offline && st === 'running' ? <span className="state-tag s-stale" title={t('Mất kết nối tới Video Studio — trạng thái có thể đã cũ')}>{t('mất kết nối')}</span> : null}
          </h1>
        </div>
        <div className="acts">
          {!step.manual && st !== 'running' ? (
            <Select
              size="sm"
              value={step.model || ''}
              options={[...MODELS, ...(!step.model || MODELS.some(([v]) => v === step.model) ? [] : [[step.model, step.model]])].map(([value, label]) => ({ value, label: value === '' ? defaultModelLabel(t, defModel) : t(label) }))}
              onChange={async (m) => {
                try {
                  await api.setStepModel(projectId, stepKey, m);
                  load();
                } catch (e) {
                  setActionErr(e.message);
                }
              }}
              label={t('Model của bước này')}
            />
          ) : null}
          {buttons}
          <button type="button" className="btn" onClick={() => setPipeEdit(true)} disabled={st === 'running'} title={st === 'running' ? t('Đang chạy — chờ xong hoặc dừng rồi mới sửa quy trình') : t('Đổi chỗ, thêm, bớt các bước chưa chạy của dự án này')}>
            {t('Sửa quy trình')}
          </button>
        </div>
        <div className="meta">
          <span className="ro" title={t('Quy trình của dự án này')}>
            <i>{t('Quy trình')}</i> <b>{project.preset?.name || '—'}</b>
          </span>
          <span className="ro">
            <i>{t('Bước')}</i> <b>{idx + 1}/{total}</b>
          </span>
          <span className="ro">
            <i>{t('Lượt')}</i> <b>{selRun ? `${selRun.n}${isLatest ? '' : ` / ${runs[0].n}`}` : '—'}</b>
          </span>
          <span className="ro">
            <i>{t('Thời gian chạy')}</i> <b>{selRun ? fmtElapsed(runElapsed(selRun, now)) : '—'}</b>
          </span>
          <span className="ro" title={t('Token của lượt đang chọn')}>
            <i>{t('Token lượt')}</i> <b title={tokens ? fmtNum(tokens) : ''}>{tokens ? fmtTokens(tokens) : '—'}</b>
          </span>
          <span className="ro" title={t('Cộng mọi lượt của bước này')}>
            <i>{t('Tổng bước')}</i> <b title={fmtNum(stepTotal)}>{stepTotal ? fmtTokens(stepTotal) : '—'}</b>
          </span>
          <span className="ro" title={t('Cộng mọi lượt của mọi bước trong dự án')}>
            <i>{t('Tổng dự án')}</i> <b title={fmtNum(projectTotal)}>{projectTotal ? fmtTokens(projectTotal) : '—'}</b>
          </span>
          <span className="ro" title={t('Chỉ hiển thị, chưa tự chạy bước sau')}>
            <i>{t('Cổng')}</i> <b>{gateLabel(step.gate_mode)}</b>
          </span>
          {costLine ? (
            <span className="ro paid">
              <i>{t('Tốn tiền')}</i> <b>{costLine}</b>
            </span>
          ) : null}
        </div>
      </div>
      {pipeEdit ? <ProjectPipelineModal projectId={projectId} onClose={() => setPipeEdit(false)} onSaved={load} /> : null}

      {showWarn ? (
        <div className="warn-note can-run" role="status">
          {canRun.message}
        </div>
      ) : null}
      {st === 'manual' ? (
        <div className="warn-note can-run">{t('Việc tay: làm trong thư mục dự án, xong thì bấm "Đánh dấu xong".')}</div>
      ) : null}
      {st === 'pending' ? <div className="warn-note can-run">{t('Các bước trước phải xong trước.')}</div> : null}
      {step.manual && st === 'done' ? <div className="note can-run">{t('Việc tay đã đánh dấu xong.')}</div> : null}
      {actionErr ? (
        <div className="err-note can-run" role="alert">
          {actionErr}
        </div>
      ) : null}

      <div className="line-panel">
        <Flow steps={project.steps || []} projectId={project.id} currentKey={step.key} large label={t('Các bước của {n}', { n: project.title })} />
      </div>

      <div className="subtabs" role="group" aria-label={t('Nội dung bước')}>
        {[
          [
            'log',
            t('Nhật ký'),
            null,
          ],
          ['out', t('Đầu ra'), artifacts.length],
          ['checks', t('Kiểm tra'), checks.length || step.checks?.length || 0],
          ['prompt', 'Prompt', null],
          ['detail', t('Chi tiết'), null],
        ].map(([k, label, n]) => (
          <button key={k} type="button" aria-pressed={curTab === k} className={curTab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {label}
            {n ? <span className="n">{n}</span> : null}
          </button>
        ))}
        {nextBtn}
      </div>

      {decide ? (
        <div className="card pad decide ask side" style={{ marginBottom: 16 }}>
          <h2>{t('Claude cần bạn trả lời')}</h2>
          <ResultBody run={selRun} grant={grant} />
          {feedbackBox}
        </div>
      ) : live || selRun?.error || selRun?.denials?.length ? (
        <div className="side" style={{ marginBottom: 16 }}>
          <ResultCard run={selRun} live={live} grant={grant} />
        </div>
      ) : null}

      <div className="step-grid one">
        <section>
          {curTab === 'log' ? (
            selRun ? (
              <LogTerminal run={selRun} offline={offline} />
            ) : (
              <div className="card empty">{t('Chưa chạy lượt nào.')}</div>
            )
          ) : null}
          {curTab === 'out' ? (
            <Outputs projectId={project.id} artifacts={artifacts} fromResult={!isLatest} runN={selRun?.n} outputs={step.outputs || []} running={live} />
          ) : null}
          {curTab === 'checks' ? (
            <>
              {!isLatest ? <div className="warn-note" style={{ marginBottom: 12 }}>{t('Kết quả kiểm tra chỉ lưu cho lượt mới nhất (lượt {n}).', { n: runs[0]?.n })}</div> : null}
              <Checks checks={checks} configured={step.checks || []} running={live} hasRun={!!selRun} />
            </>
          ) : null}
          {curTab === 'prompt' ? (
            <div className="card pad">
              {selRun?.feedback ? (
                <>
                  <h2>{t('Góp ý kèm lượt {n}', { n: selRun.n })}</h2>
                  <pre className="box-pre" style={{ marginBottom: 16 }}>{selRun.feedback}</pre>
                </>
              ) : null}
              <h2>{selRun ? `Prompt đã gửi · lượt ${selRun.n}` : t('Mẫu prompt (chưa gửi)')}</h2>
              <pre className="box-pre">{selRun ? selRun.prompt || t('(không lưu prompt)') : step.prompt_template || t('(trống)')}</pre>
              {selRun && step.prompt_template ? (
                <details style={{ marginTop: 14 }}>
                  <summary className="sum">{t('Lời dặn trong quy trình')}</summary>
                  <pre className="box-pre" style={{ marginTop: 8 }}>{step.prompt_template}</pre>
                </details>
              ) : null}
              {selRun?.allow_paid ? <p className="note">{t('Lượt này đã được bạn cho phép dùng dịch vụ trả phí.')}</p> : null}
            </div>
          ) : null}
          {curTab === 'detail' ? (
            <div className="card pad side">
              <h2>{t('Token đã dùng')}</h2>
              <h3>{t('Từng lượt của bước này')}</h3>
              {runs.length ? (
                runs.map((r) => {
                  const u = r.usage || {};
                  const dur = r.started_at && r.ended_at ? Date.parse(r.ended_at) - Date.parse(r.started_at) : 0;
                  return (
                    <details key={r.id} className="run-d" open={r.id === selRun?.id} onToggle={(e) => e.currentTarget.open && r.id !== selRun?.id && setSelRunId(r.id)}>
                      <summary className="row">
                        <span>{t('Lượt')} {r.n} · {STATE_LABEL[r.state] || r.state}{r.started_at ? ` · ${fmtDateTime(r.started_at)}` : ''}{dur > 0 ? ` · ${fmtDuration(dur)}` : ''}</span>
                        <b title={fmtNum(usageTokens(u))}>{usageTokens(u) ? fmtTokens(usageTokens(u)) : '—'}</b>
                      </summary>
                      <div className="run-b">
                        {r.feedback ? <><h3>{t('Góp ý kèm lượt {n}', { n: r.n })}</h3><pre className="box-pre">{r.feedback}</pre></> : null}
                        <ResultBody run={r} grant={null} />
                        <p className="note">
                          {t('Token vào')} {fmtNum(u.input_tokens || 0)} · {t('Token ra')} {fmtNum(u.output_tokens || 0)} · {t('Cache đọc / ghi')} {fmtNum(u.cache_read_input_tokens || 0)} / {fmtNum(u.cache_creation_input_tokens || 0)}
                        </p>
                      </div>
                    </details>
                  );
                })
              ) : (
                <p className="note">{t('Chưa có lượt nào.')}</p>
              )}
              <div className="row"><span>{t('Tổng bước này')}</span><b title={fmtNum(stepTotal)}>{fmtTokens(stepTotal)}</b></div>
              <h3>{t('Từng bước')}</h3>
              {byStep.map((s) => (
                <div className="row" key={s.key}>
                  <span>{s.name}{s.key === step.key ? ' ●' : ''} · {t('{n} lượt', { n: s.runs })}</span>
                  <b title={fmtNum(s.total)}>{s.total ? fmtTokens(s.total) : '—'}</b>
                </div>
              ))}
              <div className="row"><span>{t('Từ bước đầu tới bước này')}</span><b title={fmtNum(uptoHere)}>{fmtTokens(uptoHere)}</b></div>
              <div className="row"><span>{t('Cả dự án')}</span><b title={fmtNum(projectTotal)}>{fmtTokens(projectTotal)}</b></div>
              <h3>{t('Chi phí &amp; thông tin')}</h3>
              <div className="row"><span>{t('Chi phí')} USD</span><b>{project.costs?.usd != null ? fmtUsd(project.costs.usd) : '—'}</b></div>
              <div className="row"><span>{t('Giới hạn thời gian')}</span><b>{step.timeout_ms ? fmtDuration(step.timeout_ms) : '—'}</b></div>
              <div className="row"><span>{t('Thư mục')}</span><b className="wrap-any">{project.dir || '—'}</b></div>
              {view.resume_cmd ? <div className="row"><span>{t('Lệnh mở phiên')}</span><b className="wrap-any">{view.resume_cmd}</b></div> : null}
              <p className="note">{t('Gồm cả token cache. Chỉ tính các lượt chạy bước, chưa tính Trợ lý AI.')}</p>
            </div>
          ) : null}
        </section>

      </div>

      {distillOpen ? <DistillModal projectId={projectId} stepKey={stepKey} stepName={step.name} stepDone={st === 'done'} doneCount={doneUpto} onClose={() => setDistillOpen(false)} /> : null}
      {rerunAsk ? (
        <Modal title={t('Chạy lại "{n}"?', { n: step.name })} lead={t('Lượt mới có thể ghi đè các đầu ra hiện có của bước này.')} onClose={() => setRerunAsk(false)}>
          <p className="note">{t('Lịch sử các lượt cũ vẫn được giữ. Muốn sửa theo góp ý thì dùng "Chạy lại kèm góp ý".')}</p>
          <div className="modal-acts">
            <button type="button" className="btn" onClick={() => setRerunAsk(false)}>{t('Hủy')}</button>
            <button type="button" className={`btn ${paid ? 'paid' : 'primary'}`} data-autofocus onClick={() => { setRerunAsk(false); requestRun(''); }}>{paid ? '$ ' : ''}{t('Chạy lại')}</button>
          </div>
        </Modal>
      ) : null}
      {costAsk ? (
        <CostModal
          stepName={step.name}
          cost={costAsk.cost || step.cost}
          withFeedback={!!costAsk.feedback}
          busy={busy === 'run'}
          onClose={() => setCostAsk(null)}
          onConfirm={() => doRun(costAsk.feedback, true, costAsk.allowOnce)}
        />
      ) : null}
    </>
  );
}
