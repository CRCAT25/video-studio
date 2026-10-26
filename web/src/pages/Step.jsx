// Trang chi tiết bước: tiêu đề + nút theo §5, sơ đồ bước, tab Nhật ký/Đầu ra/Kiểm tra/Prompt, cột góp ý + chi tiết.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Flow from '../components/Flow.jsx';
import CostModal from '../components/CostModal.jsx';
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
import { stepHref } from '../lib/router.js';

const FEEDBACK_MAX = 20000;
const RUNNABLE = new Set(['ready', 'done', 'failed', 'needs_input', 'stale']);
const COMPLETABLE = new Set(['failed', 'needs_input', 'stale', 'manual']);

// Trang Chi tiết bước; thiếu stepKey thì chuyển tới bước hiện tại của dự án.
export default function Step({ projectId, stepKey }) {
  if (!stepKey) return <StepRedirect projectId={projectId} />;
  return <StepPage projectId={projectId} stepKey={stepKey} />;
}

function StepRedirect({ projectId }) {
  const [err, setErr] = useState(null);
  useEffect(() => {
    const ac = new AbortController();
    api
      .project(projectId, { signal: ac.signal })
      .then((p) => {
        const key = p?.current?.key || p?.steps?.[0]?.key;
        if (key) window.location.replace(stepHref(projectId, key));
        else setErr(new Error('Dự án chưa có bước nào.'));
      })
      .catch((e) => {
        if (e?.name !== 'AbortError') setErr(e);
      });
    return () => ac.abort();
  }, [projectId]);
  if (err) return <NotFound message={err.status === 404 ? `Không tìm thấy dự án "${projectId}".` : err.message} />;
  return <StepSkeleton label="Đang mở dự án" />;
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
      <div className="step-grid">
        <Sk block h={477} />
        <div className="side">
          <div className="card pad">
            <h2>
              <Sk w="6em" />
            </h2>
            <SkLines n={3} />
          </div>
          <div className="card pad">
            <h2>
              <Sk w="4em" />
            </h2>
            <Sk block h={80} />
          </div>
        </div>
      </div>
    </SkZone>
  );
}

function NotFound({ message }) {
  return (
    <div className="card pad empty">
      <b>{message}</b>
      <p className="note">
        <a href="#/">Về Tổng quan</a>
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

// Thân kết quả lượt: lỗi, tóm tắt, câu hỏi, ghi chú cho bước sau, các lần bị chặn quyền.
function ResultBody({ run, live = false }) {
  const r = run.result || {};
  const questions = Array.isArray(r.questions) ? r.questions.filter(Boolean) : [];
  const denials = Array.isArray(run.denials) ? run.denials : [];
  const summary = r.summary || run.summary;
  return (
    <div className="result">
      {run.error ? <div className="err-note">{run.error}</div> : null}
      {summary ? <p>{summary}</p> : !live && !run.error ? <p className="muted">Lượt này không có tóm tắt.</p> : null}
      {questions.length ? (
        <>
          <h3>Claude hỏi</h3>
          <ul>
            {questions.map((q, i) => (
              <li key={i}>{String(q)}</li>
            ))}
          </ul>
        </>
      ) : null}
      {r.notes_for_next_step ? (
        <>
          <h3>Ghi chú cho bước sau</h3>
          <p>{String(r.notes_for_next_step)}</p>
        </>
      ) : null}
      {denials.length ? (
        <>
          <h3>Bị chặn quyền ({denials.length})</h3>
          {denials.slice(0, 20).map((d, i) => (
            <div key={i} className="denial">
              ✕ {denialText(d)}
            </div>
          ))}
          <p className="note">Thêm quyền vào mục permissions của quy trình nếu bước thật sự cần.</p>
        </>
      ) : null}
    </div>
  );
}

// Thẻ kết quả lượt (kèm thanh tiến độ khi đang chạy).
function ResultCard({ run, live }) {
  if (!run) {
    return (
      <div className="card pad">
        <h2>Kết quả</h2>
        <p className="muted small" style={{ margin: 0 }}>
          Chưa chạy lượt nào.
        </p>
      </div>
    );
  }
  const pct = run.progress_pct != null ? Math.max(0, Math.min(100, Number(run.progress_pct))) : null;
  return (
    <div className="card pad">
      <h2>Kết quả · lượt {run.n}</h2>
      {live ? (
        <>
          <div className="bar" title={pct != null ? `${Math.round(pct)}%` : 'Đang chạy'}>
            <i style={{ width: `${pct != null ? Math.max(3, pct) : 100}%`, opacity: pct != null ? 1 : 0.5 }} />
          </div>
          <div className="prog-msg" style={{ marginBottom: 10 }}>
            {pct != null ? `${Math.round(pct)}% · ` : ''}
            {run.progress_msg || 'Claude đang làm…'}
          </div>
        </>
      ) : null}
      <ResultBody run={run} live={live} />
    </div>
  );
}

function StepPage({ projectId, stepKey }) {
  const toast = useToast();
  const [view, setView] = useState(null);
  const [err, setErr] = useState(null);
  const [selRunId, setSelRunId] = useState(null);
  const [tab, setTab] = useState(null);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(null);
  const [costAsk, setCostAsk] = useState(null);
  const [actionErr, setActionErr] = useState(null);
  const [copied, setCopied] = useState(false);
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
    if (step && project) document.title = `${step.name} · ${project.title} · Video Studio`;
  }, [step?.name, project?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err && !view) {
    if (err.status === 404) return <NotFound message={err.message || 'Không tìm thấy bước này.'} />;
    return (
      <div className="card pad">
        <div className="err-note" role="alert">
          Không tải được bước: {err.message}
        </div>
        <p className="note">
          <button type="button" className="linkbtn" onClick={load}>
            Thử lại
          </button>{' '}
          · <a href="#/">Về Tổng quan</a>
        </p>
      </div>
    );
  }
  if (!view || !step || !project) {
    return <StepSkeleton label="Đang tải bước" />;
  }

  const st = step.state;
  const idx = (project.steps || []).findIndex((s) => s.key === step.key);
  const total = project.steps?.length || 0;
  const prevOk = (project.steps || []).slice(0, Math.max(0, idx)).every((s) => s.state === 'done' || s.state === 'stale');
  const canRun = view.can_run || { ok: false };
  const paid = !!(step.cost || step.has_cost);
  const fbTrim = feedback.trim();

  const doRun = async (fb, allowPaid = false) => {
    setBusy('run');
    setActionErr(null);
    try {
      await api.runStep(projectId, stepKey, { feedback: fb || undefined, allowPaid });
      setCostAsk(null);
      if (fb) setFeedback('');
      setSelRunId(null);
      setTab('log');
      toast(`Đã bắt đầu chạy "${step.name}".`, 'ok');
      await load();
    } catch (e) {
      if (e.status === 412) {
        setCostAsk({ cost: e.data?.cost || step.cost, feedback: fb });
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
      toast('Viết góp ý hoặc câu trả lời cho Claude trước đã.', 'info');
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
      toast('Đã gửi lệnh dừng.', 'info');
      await load();
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
      toast(`Đã đánh dấu xong "${step.name}".`, 'ok');
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
      toast('Đã chép lệnh — dán vào terminal để làm tiếp phiên này.', 'ok');
    } else {
      toast('Không chép được vào clipboard — chọn lệnh ở cột bên rồi tự chép.', 'err');
    }
  };

  // Nút chính theo trạng thái (§5).
  const runDisabled = !!busy || !canRun.ok;
  const runTitle = canRun.ok ? (paid ? 'Bước tốn tiền — sẽ hỏi xác nhận chi phí' : '') : canRun.message || 'Chưa chạy được';
  const buttons = [];
  if (st === 'running') {
    buttons.push(
      <button key="stop" type="button" className="btn danger" onClick={doStop} disabled={!!busy}>
        {busy === 'stop' ? <span className="spinner" aria-hidden="true" /> : null}Dừng
      </button>,
    );
  } else if (st === 'needs_input') {
    buttons.push(
      <button key="fb" type="button" className={`btn ${paid ? 'paid' : 'primary'}`} onClick={runWithFeedback} disabled={runDisabled} title={runTitle}>
        {busy === 'run' ? <span className="spinner" aria-hidden="true" /> : paid ? '$ ' : ''}Chạy lại kèm góp ý
      </button>,
    );
  } else if (RUNNABLE.has(st) && !step.manual) {
    buttons.push(
      <button key="run" type="button" className={`btn ${paid ? 'paid' : st === 'done' ? '' : 'primary'}`} onClick={() => requestRun('')} disabled={runDisabled} title={runTitle}>
        {busy === 'run' ? <span className="spinner" aria-hidden="true" /> : null}
        {paid ? `$ ${st === 'ready' ? 'Chạy' : 'Chạy lại'}` : st === 'ready' ? 'Chạy' : 'Chạy lại'}
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
        title={prevOk ? 'Đánh dấu bước này đã xong (bước sau sẽ sẵn sàng)' : 'Các bước trước phải xong trước'}
      >
        {busy === 'complete' ? <span className="spinner" aria-hidden="true" /> : null}Đánh dấu xong
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
      title={view.resume_cmd ? 'Chép lệnh mở phiên Claude này trong terminal để làm tay' : 'Chưa có phiên Claude — chạy một bước trước đã'}
    >
      {copied ? 'Đã chép lệnh' : 'Mở trong terminal'}
    </button>,
  );

  const tokens = runTokens(selRun, isLatest ? latest?.costs : null);
  const artifacts = isLatest ? latest?.artifacts || [] : selRun?.result?.artifacts || [];
  const checks = isLatest ? latest?.checks || [] : [];
  const curTab = tab || 'log';
  const costLine = step.cost
    ? `${step.cost.service || 'dịch vụ'}${step.cost.estimate_value != null ? ` · ~${fmtNum(step.cost.estimate_value)} ${step.cost.unit || ''}` : ''}`
    : null;
  const u = selRun?.usage || null;
  const showWarn = !canRun.ok && canRun.message && !step.manual && st !== 'running' && st !== 'pending';
  const decide = st === 'needs_input' && isLatest;

  const feedbackBox = (
    <>
      <label className="sr-only" htmlFor="fb">
        Góp ý cho lượt sau
      </label>
      <textarea
        id="fb"
        ref={fbRef}
        value={feedback}
        maxLength={FEEDBACK_MAX}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder={decide ? 'Trả lời Claude hoặc góp ý…' : 'Vd: đoạn mở đầu ngắn lại, giọng ấm hơn'}
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
          {runs.length ? 'Chạy lại kèm góp ý' : 'Chạy kèm góp ý'}
        </button>
      </div>
    </>
  );

  return (
    <>
      <div className="crumb">
        <a href="#/">Tổng quan</a> <span className="sep">/</span> <span>{project.title}</span> <span className="sep">/</span> <span>{step.name}</span>
      </div>

      <div className="step-head">
        <div>
          <h1>
            {step.name}
            <span className={`state-tag s-${st}`}>
              {st === 'running' ? <span className="dot" /> : null}
              {STATE_LABEL[st] || st}
            </span>
            {offline && st === 'running' ? <span className="state-tag s-stale" title="Mất kết nối tới Video Studio — trạng thái có thể đã cũ">mất kết nối</span> : null}
          </h1>
          <div className="meta">
            <span className="ro">
              <i>Bước</i> <b>{idx + 1}/{total}</b>
            </span>
            <span className="ro">
              <i>Lượt</i> <b>{selRun ? `${selRun.n}${isLatest ? '' : ` / ${runs[0].n}`}` : '—'}</b>
            </span>
            <span className="ro">
              <i>Thời gian chạy</i> <b>{selRun ? fmtElapsed(runElapsed(selRun, now)) : '—'}</b>
            </span>
            <span className="ro">
              <i>Token</i> <b title={tokens ? fmtNum(tokens) : ''}>{tokens ? fmtTokens(tokens) : '—'}</b>
            </span>
            <span className="ro" title="Chỉ hiển thị, chưa tự chạy bước sau">
              <i>Cổng</i> <b>{gateLabel(step.gate_mode)}</b>
            </span>
            {costLine ? (
              <span className="ro paid">
                <i>Tốn tiền</i> <b>{costLine}</b>
              </span>
            ) : null}
          </div>
        </div>
        <div className="acts">{buttons}</div>
      </div>

      {showWarn ? (
        <div className="warn-note can-run" role="status">
          {canRun.message}
        </div>
      ) : null}
      {st === 'manual' ? (
        <div className="warn-note can-run">Việc tay: làm trong thư mục dự án, xong thì bấm "Đánh dấu xong".</div>
      ) : null}
      {st === 'pending' ? <div className="warn-note can-run">Các bước trước phải xong trước.</div> : null}
      {step.manual && st === 'done' ? <div className="note can-run">Việc tay đã đánh dấu xong.</div> : null}
      {actionErr ? (
        <div className="err-note can-run" role="alert">
          {actionErr}
        </div>
      ) : null}

      <div className="line-panel">
        <Flow steps={project.steps || []} projectId={project.id} currentKey={step.key} large label={`Các bước của ${project.title}`} />
      </div>

      <div className="subtabs" role="group" aria-label="Nội dung bước">
        {[
          [
            'log',
            'Nhật ký',
            null,
          ],
          ['out', 'Đầu ra', artifacts.length],
          ['checks', 'Kiểm tra', checks.length || step.checks?.length || 0],
          ['prompt', 'Prompt', null],
        ].map(([k, label, n]) => (
          <button key={k} type="button" aria-pressed={curTab === k} className={curTab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {label}
            {n ? <span className="n">{n}</span> : null}
          </button>
        ))}
      </div>

      <div className="step-grid">
        <section>
          {curTab === 'log' ? (
            selRun ? (
              <LogTerminal run={selRun} offline={offline} />
            ) : (
              <div className="card empty">Chưa chạy lượt nào.</div>
            )
          ) : null}
          {curTab === 'out' ? (
            <Outputs projectId={project.id} artifacts={artifacts} fromResult={!isLatest} runN={selRun?.n} outputs={step.outputs || []} running={live} />
          ) : null}
          {curTab === 'checks' ? (
            <>
              {!isLatest ? <div className="warn-note" style={{ marginBottom: 12 }}>Kết quả kiểm tra chỉ lưu cho lượt mới nhất (lượt {runs[0]?.n}).</div> : null}
              <Checks checks={checks} configured={step.checks || []} running={live} hasRun={!!selRun} />
            </>
          ) : null}
          {curTab === 'prompt' ? (
            <div className="card pad">
              {selRun?.feedback ? (
                <>
                  <h2>Góp ý kèm lượt {selRun.n}</h2>
                  <pre className="box-pre" style={{ marginBottom: 16 }}>{selRun.feedback}</pre>
                </>
              ) : null}
              <h2>{selRun ? `Prompt đã gửi · lượt ${selRun.n}` : 'Mẫu prompt (chưa gửi)'}</h2>
              <pre className="box-pre">{selRun ? selRun.prompt || '(không lưu prompt)' : step.prompt_template || '(trống)'}</pre>
              {selRun && step.prompt_template ? (
                <details style={{ marginTop: 14 }}>
                  <summary className="sum">Lời dặn trong quy trình</summary>
                  <pre className="box-pre" style={{ marginTop: 8 }}>{step.prompt_template}</pre>
                </details>
              ) : null}
              {selRun?.allow_paid ? <p className="note">Lượt này đã được bạn cho phép dùng dịch vụ trả phí.</p> : null}
            </div>
          ) : null}
        </section>

        <aside className="side">
          {decide ? (
            <div className="card pad decide ask">
              <h2>Claude cần bạn trả lời</h2>
              <ResultBody run={selRun} />
              {feedbackBox}
            </div>
          ) : (
            <ResultCard run={selRun} live={live} />
          )}

          {!decide && !step.manual ? (
            <div className="card pad">
              <h2>Góp ý</h2>
              {feedbackBox}
            </div>
          ) : null}

          <details className="card pad more">
            <summary>
              Chi tiết <span className="muted">· {runs.length} lượt</span>
            </summary>
            <h3>Các lượt</h3>
            {runs.length ? (
              <div className="runs runs-wrap" role="group" aria-label="Chọn lượt để xem">
                {runs.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    aria-pressed={r.id === selRun?.id}
                    className={`s-${r.state}${r.id === selRun?.id ? ' on' : ''}`}
                    onClick={() => setSelRunId(r.id === runs[0].id ? null : r.id)}
                    title={r.summary || r.error || ''}
                  >
                    <span className="rn">
                      <i className="lamp" />
                      Lượt <span className="num">{r.n}</span>
                      {r.feedback ? <span className="tag" title="Có góp ý">góp ý</span> : null}
                    </span>
                    <span className="rs">{RUN_LABEL[r.state] || r.state}</span>
                    <span className="rt">{fmtDateTime(r.started_at)}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted small" style={{ margin: 0 }}>
                Chưa có lượt nào.
              </p>
            )}
            <h3>Chi phí &amp; thông tin</h3>
            <div className="row">
              <span className="muted">Token vào</span>
              <b>{u ? fmtNum((Number(u.input_tokens) || 0)) : '—'}</b>
            </div>
            <div className="row">
              <span className="muted">Token ra</span>
              <b>{u ? fmtNum(Number(u.output_tokens) || 0) : '—'}</b>
            </div>
            <div className="row">
              <span className="muted">Cache đọc / ghi</span>
              <b>
                {u ? `${fmtTokens(u.cache_read_input_tokens || 0)} / ${fmtTokens(u.cache_creation_input_tokens || 0)}` : '—'}
              </b>
            </div>
            {u?.api_key && u.total_cost_usd != null ? (
              <div className="row">
                <span className="muted">USD (API key)</span>
                <b>{fmtUsd(u.total_cost_usd)}</b>
              </div>
            ) : null}
            <div className="row">
              <span className="muted">Cả dự án</span>
              <b>
                {fmtTokens(usageTokens(project.costs))} token · {fmtNum(project.costs?.runs ?? 0)} lượt
              </b>
            </div>
            {step.timeout_ms ? (
              <div className="row">
                <span className="muted">Giới hạn thời gian</span>
                <b>{fmtDuration(step.timeout_ms)}</b>
              </div>
            ) : null}
            <div className="row">
              <span className="muted">Thư mục</span>
              <b className="wrap-any">{project.dir}</b>
            </div>
            {view.resume_cmd ? (
              <div style={{ marginTop: 10 }}>
                <div className="muted small" style={{ marginBottom: 6 }}>
                  Lệnh mở phiên
                </div>
                <pre className="box-pre">{view.resume_cmd}</pre>
              </div>
            ) : null}
          </details>
        </aside>
      </div>

      {costAsk ? (
        <CostModal
          stepName={step.name}
          cost={costAsk.cost || step.cost}
          withFeedback={!!costAsk.feedback}
          busy={busy === 'run'}
          onClose={() => setCostAsk(null)}
          onConfirm={() => doRun(costAsk.feedback, true)}
        />
      ) : null}
    </>
  );
}
