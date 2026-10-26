// Tab Đầu ra (video/âm thanh/ảnh/chữ từ /media, không render HTML) và tab Kiểm tra (Đạt / Trượt / Bỏ qua).
import { useEffect, useState } from 'react';
import { fetchText, mediaUrl } from '../api.js';
import { KIND_LABEL, fmtBytes, fmtDateTime, fmtDuration } from '../lib/format.js';
import { DownloadIcon } from './icons.jsx';

const ORDER = ['video', 'audio', 'image', 'markdown', 'json', 'text', 'other'];
const TEXT_KINDS = new Set(['markdown', 'json', 'text']);
const AUTO_TEXT = 4; // tự tải nội dung tối đa 4 file chữ đầu tiên

// Đoán kind theo đuôi file khi Claude không khai báo.
export function guessKind(path) {
  const ext = String(path || '').toLowerCase().split('.').pop();
  if (['mp4', 'mov', 'webm', 'm4v', 'mkv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(ext)) return 'image';
  if (['md', 'markdown'].includes(ext)) return 'markdown';
  if (ext === 'json') return 'json';
  if (['txt', 'srt', 'vtt', 'csv', 'log', 'yaml', 'yml'].includes(ext)) return 'text';
  return 'other';
}

function srcOf(projectId, path) {
  const p = String(path || '');
  return mediaUrl(projectId, p, { studio: p.startsWith('.studio/runs/') });
}

function baseName(p) {
  const s = String(p || '');
  return s.slice(s.lastIndexOf('/') + 1) || s;
}

function Meta({ a }) {
  const parts = [];
  if (a.bytes != null) parts.push(fmtBytes(a.bytes));
  if (a.mtime) parts.push(fmtDateTime(a.mtime));
  return parts.length ? <span className="out-meta">{parts.join(' · ')}</span> : null;
}

function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// Xem trước file chữ: tải tối đa 256 KB, hiện trong <pre> (không bao giờ render HTML/markdown).
function TextPreview({ projectId, a, auto }) {
  const [open, setOpen] = useState(auto);
  const [state, setState] = useState({ loading: false, text: null, truncated: false, error: null });
  const src = srcOf(projectId, a.path);

  useEffect(() => {
    if (!open) return undefined;
    const ac = new AbortController();
    setState({ loading: true, text: null, truncated: false, error: null });
    fetchText(src, { signal: ac.signal })
      .then(({ text, truncated }) => {
        const shown = a.kind === 'json' && !truncated ? prettyJson(text) : text;
        setState({ loading: false, text: shown, truncated, error: null });
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        setState({ loading: false, text: null, truncated: false, error: e });
      });
    return () => ac.abort();
  }, [open, src, a.kind]);

  return (
    <div className="text-out">
      <div className="hd">
        <div style={{ minWidth: 0 }}>
          <b>{a.label || baseName(a.path)}</b>
          <div className="mono">{a.path}</div>
        </div>
        <span className="acts">
          <Meta a={a} />
          {open ? null : (
            <button type="button" className="btn sm" onClick={() => setOpen(true)}>
              Xem nội dung
            </button>
          )}
          <a className="btn sm" href={src} download={baseName(a.path)}>
            <DownloadIcon /> Tải
          </a>
        </span>
      </div>
      {open ? (
        state.loading ? (
          <div className="note">
            <span className="spinner" aria-hidden="true" /> Đang tải…
          </div>
        ) : state.error ? (
          <div className="err-note" role="alert">
            {state.error.message}
          </div>
        ) : state.text != null ? (
          <>
            <pre className="box-pre">{state.text || '(file trống)'}</pre>
            {state.truncated ? <div className="note">Đã cắt bớt — chỉ hiện 256 KB đầu. Tải file để xem đủ.</div> : null}
          </>
        ) : null
      ) : null}
    </div>
  );
}

// Danh sách đầu ra theo nhóm kind; fromResult = lấy từ kết quả của lượt cũ (file có thể đã bị ghi đè).
export default function Outputs({ projectId, artifacts = [], fromResult = false, runN, outputs = [], running = false }) {
  const list = (artifacts || [])
    .filter((a) => a && a.path)
    .map((a) => ({ ...a, kind: ORDER.includes(a.kind) ? a.kind : guessKind(a.path) }));

  if (!list.length) {
    return (
      <div className="card pad">
        <div className="empty">
          <b>{running ? 'Claude đang làm — chưa có đầu ra.' : 'Lượt này chưa có đầu ra nào.'}</b>
          <p className="note">
            Đầu ra hiện ở đây khi Claude kết thúc bước và khai báo trong kết quả.
            {outputs?.length ? (
              <>
                {' '}Preset dự kiến: <span className="mono wrap-any">{outputs.join(', ')}</span>
              </>
            ) : null}
          </p>
        </div>
      </div>
    );
  }

  const groups = ORDER.map((k) => [k, list.filter((a) => a.kind === k)]).filter(([, arr]) => arr.length);
  let textIdx = 0;
  return (
    <div>
      {fromResult ? (
        <div className="warn-note" style={{ marginBottom: 14 }}>
          Đây là đầu ra Claude khai báo ở lượt {runN ?? 'cũ'}. File cùng tên có thể đã bị lượt sau ghi đè.
        </div>
      ) : null}
      {groups.map(([kind, arr]) => (
        <section key={kind} className="out-group card pad">
          <h2>
            {KIND_LABEL[kind] || kind} <span className="num dim">{arr.length}</span>
          </h2>
          {kind === 'video'
            ? arr.map((a) => (
                <div key={a.id ?? a.path}>
                  <div className="player">
                    <video controls preload="metadata" src={srcOf(projectId, a.path)} />
                    <div className="cap">
                      {a.path}
                      {runN ? ` · lượt ${runN}` : ''}
                    </div>
                  </div>
                  <div className="out-row">
                    <div className="lbl">
                      <b>{a.label || baseName(a.path)}</b>
                      <span className="mono">{a.path}</span>
                    </div>
                    <Meta a={a} />
                  </div>
                </div>
              ))
            : null}
          {kind === 'audio'
            ? arr.map((a) => (
                <div key={a.id ?? a.path} className="out-row">
                  <div className="lbl">
                    <b>{a.label || baseName(a.path)}</b>
                    <span className="mono">{a.path}</span>
                  </div>
                  <Meta a={a} />
                  <audio controls preload="metadata" src={srcOf(projectId, a.path)} />
                </div>
              ))
            : null}
          {kind === 'image' ? (
            <div className="imgs">
              {arr.map((a) => (
                <a key={a.id ?? a.path} href={srcOf(projectId, a.path)} target="_blank" rel="noopener noreferrer" title={`${a.label || a.path}${a.bytes != null ? ` · ${fmtBytes(a.bytes)}` : ''}`}>
                  <img src={srcOf(projectId, a.path)} alt={a.label || baseName(a.path)} loading="lazy" />
                  <span>{a.label || baseName(a.path)}</span>
                </a>
              ))}
            </div>
          ) : null}
          {TEXT_KINDS.has(kind)
            ? arr.map((a) => {
                textIdx += 1;
                return <TextPreview key={a.id ?? a.path} projectId={projectId} a={a} auto={textIdx <= AUTO_TEXT} />;
              })
            : null}
          {kind === 'other'
            ? arr.map((a) => (
                <div key={a.id ?? a.path} className="out-row">
                  <div className="lbl">
                    <b>{a.label || baseName(a.path)}</b>
                    <span className="mono">{a.path}</span>
                  </div>
                  <Meta a={a} />
                  <a className="btn sm" href={srcOf(projectId, a.path)} download={baseName(a.path)}>
                    <DownloadIcon /> Tải về
                  </a>
                </div>
              ))
            : null}
        </section>
      ))}
    </div>
  );
}

// Tab Kiểm tra: kết quả lệnh check do app chạy (không phải Claude tự chấm); configured = checks khai báo trong preset.
export function Checks({ checks = [], configured = [], running = false, hasRun = true }) {
  if (!checks.length) {
    return (
      <div className="card pad">
        {configured.length ? (
          <>
            {configured.map((c) => (
              <div key={c.name} className="check">
                <span className="pf s">CHƯA CHẠY</span>
                <div>
                  <b>{c.name}</b>
                  <code>{c.run}</code>
                </div>
              </div>
            ))}
            <p className="note" style={{ margin: '10px 0 0' }}>
              {running ? 'Kiểm tra sẽ chạy khi Claude xong bước.' : hasRun ? 'Lượt này chưa chạy kiểm tra (chỉ chạy khi Claude báo xong).' : 'Bước chưa chạy lượt nào.'}
            </p>
          </>
        ) : (
          <div className="empty">
            <b>Bước này không có kiểm tra tự động.</b>
            <p className="note">Khai báo trong mục <span className="mono">checks</span> của preset nếu muốn app tự chạy lệnh kiểm tra.</p>
          </div>
        )}
      </div>
    );
  }
  const pass = checks.filter((c) => c.passed === 1 || c.passed === true).length;
  const fail = checks.filter((c) => c.passed === 0 || c.passed === false).length;
  return (
    <div className="card pad">
      <h2>
        Kiểm tra · <span className="num">{pass} đạt / {fail} trượt / {checks.length - pass - fail} bỏ qua</span>
      </h2>
      {checks.map((c) => {
        const p = c.passed === 1 || c.passed === true;
        const f = c.passed === 0 || c.passed === false;
        return (
          <div key={c.id ?? c.name} className="check">
            <span className={`pf ${p ? 'p' : f ? 'f' : 's'}`}>{p ? 'Đạt' : f ? 'Trượt' : 'Bỏ qua'}</span>
            <div>
              <b>{c.name}</b>
              {c.duration_ms != null ? <span className="out-meta"> · {c.duration_ms < 1000 ? `${c.duration_ms} ms` : fmtDuration(c.duration_ms)}</span> : null}
              <code>{c.cmd}</code>
              {c.output ? <pre>{c.output}</pre> : null}
            </div>
          </div>
        );
      })}
      <p className="note" style={{ margin: '10px 0 0' }}>
        App tự chạy các lệnh trong <span className="mono">checks</span> của preset — Claude không tự chấm.
      </p>
    </div>
  );
}
