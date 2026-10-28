// SQLite store đồng bộ (better-sqlite3) cho M1 (hợp đồng §4, §4.1).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const SCHEMA_VERSION = 6;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL, channel_id TEXT, title TEXT NOT NULL, dir TEXT NOT NULL,
  claude_session_id TEXT,
  session_started INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS steps(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL, name TEXT NOT NULL, ord INTEGER NOT NULL,
  state TEXT NOT NULL,
  current_run_id TEXT, updated_at TEXT NOT NULL, UNIQUE(project_id, key));
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, step_id TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL, n INTEGER NOT NULL,
  state TEXT NOT NULL,
  prompt TEXT, feedback TEXT, started_at TEXT NOT NULL, ended_at TEXT,
  session_id TEXT, pid INTEGER, exit_code INTEGER,
  result_json TEXT,
  summary TEXT, error TEXT,
  allow_paid INTEGER NOT NULL DEFAULT 0,
  progress_pct INTEGER, progress_msg TEXT,
  denials_json TEXT,
  usage_json TEXT,
  UNIQUE(step_id, n));
CREATE TABLE IF NOT EXISTS run_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, payload_json TEXT,
  UNIQUE(run_id, seq));
CREATE TABLE IF NOT EXISTS artifacts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path TEXT NOT NULL, kind TEXT NOT NULL, label TEXT, bytes INTEGER, mtime TEXT);
CREATE TABLE IF NOT EXISTS checks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, cmd TEXT NOT NULL, passed INTEGER,
  output TEXT, duration_ms INTEGER);
CREATE TABLE IF NOT EXISTS costs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  units REAL NOT NULL, unit_name TEXT NOT NULL, usd REAL, note TEXT);
CREATE INDEX IF NOT EXISTS ix_runs_step ON runs(step_id);
CREATE INDEX IF NOT EXISTS ix_events_run ON run_events(run_id, seq);
`;

// v2: kết nối YouTube — chỉ thông tin công khai của kênh; token nằm trong Keychain, không bao giờ ở đây.
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS yt_channels(
  id TEXT PRIMARY KEY, yt_channel_id TEXT NOT NULL, title TEXT,
  status TEXT NOT NULL DEFAULT 'ok', can_upload INTEGER NOT NULL DEFAULT 0,
  connected_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS yt_stats_cache(
  channel_id TEXT NOT NULL, kind TEXT NOT NULL, data_json TEXT NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY(channel_id, kind));
CREATE TABLE IF NOT EXISTS yt_uploads(
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, folder TEXT NOT NULL,
  video_id TEXT, status TEXT NOT NULL, error TEXT,
  started_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE IF NOT EXISTS yt_quota(day TEXT PRIMARY KEY, units INTEGER NOT NULL DEFAULT 0);
`;

// v3: đăng nhập Google — chỉ lưu băm (chủ app, phiên); không có email/tên/token.
// V4: bản chụp quy trình (JSON) của từng dự án — sửa/xóa mẫu không ảnh hưởng dự án đã tạo.
const SCHEMA_V4 = 'ALTER TABLE projects ADD COLUMN pipeline TEXT;';

// v6: người dùng đã duyệt kết quả của bước (0/1); bắt đầu lượt chạy mới thì xóa dấu duyệt.
// Dữ liệu cũ: bước đã xong mà bước kế đã chạy/xong thì coi như đã duyệt.
const SCHEMA_V6 = `
ALTER TABLE steps ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;
UPDATE steps SET approved = 1 WHERE state = 'done' AND EXISTS (
  SELECT 1 FROM steps n WHERE n.project_id = steps.project_id AND n.ord > steps.ord
    AND n.state IN ('done','running','failed','needs_input','stale'));
`;

// v5: token của các lượt claude ngoài bước video (Trợ lý AI, Kiểm tra mức dùng) — chỉ số đếm, không nội dung.
const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS token_usage(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, source TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0, cache_read_input_tokens INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_token_usage_at ON token_usage(at);
`;

const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
`;

// Cột *_json ↔ key đã parse (không hậu tố).
const JSON_COLS = { result_json: 'result', denials_json: 'denials', usage_json: 'usage', payload_json: 'payload' };
const JSON_KEYS = Object.fromEntries(Object.entries(JSON_COLS).map(([c, k]) => [k, c]));

const now = () => new Date().toISOString();

function safeParse(text) {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toJson(v) {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function parseRow(row) {
  if (!row) return null;
  for (const [col, key] of Object.entries(JSON_COLS)) if (col in row) row[key] = safeParse(row[col]);
  return row;
}

function toIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  return String(v);
}

function boolInt(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return Number(v) ? 1 : 0;
}

function migrate(db) {
  const v = db.pragma('user_version', { simple: true });
  if (v > SCHEMA_VERSION) {
    throw new Error(`studio.db có lược đồ phiên bản ${v}, mới hơn bản app hỗ trợ (${SCHEMA_VERSION}). Hãy cập nhật Video Studio.`);
  }
  if (v >= SCHEMA_VERSION) return;
  // Nâng cấp từng bậc trong một transaction; dữ liệu cũ giữ nguyên.
  db.transaction(() => {
    if (v < 1) db.exec(SCHEMA_V1);
    if (v < 2) db.exec(SCHEMA_V2);
    if (v < 3) db.exec(SCHEMA_V3);
    if (v < 4) db.exec(SCHEMA_V4);
    if (v < 5) db.exec(SCHEMA_V5);
    if (v < 6) db.exec(SCHEMA_V6);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

// Mở (và tạo lược đồ nếu cần) CSDL SQLite tại file → Store với API đồng bộ §4.1.
export function openStore(file) {
  const isMem = file === ':memory:' || file === '';
  if (!isMem && !String(file).startsWith('file:')) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  } catch (e) {
    db.close();
    throw e;
  }

  const cache = new Map();
  const st = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const columnsOf = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  const COLS = {
    projects: columnsOf('projects'),
    steps: columnsOf('steps'),
    runs: columnsOf('runs'),
  };

  // UPDATE theo whitelist cột; key 'result'/'denials'/'usage' được stringify vào *_json.
  function update(table, id, patch, touch) {
    const cols = COLS[table];
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === undefined) continue;
      let col = k;
      let val = v;
      if (JSON_KEYS[k] && cols.has(JSON_KEYS[k])) {
        col = JSON_KEYS[k];
        val = v === null ? null : JSON.stringify(v);
      } else if (k.endsWith('_json')) {
        val = toJson(v);
      }
      if (!cols.has(col) || col === 'id') throw new Error(`Cột không hợp lệ cho bảng ${table}: ${k}`);
      if (typeof val === 'boolean') val = val ? 1 : 0;
      sets.push(`${col} = ?`);
      vals.push(val);
    }
    if (touch && !('updated_at' in (patch || {}))) {
      sets.push('updated_at = ?');
      vals.push(now());
    }
    if (sets.length) st(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  const store = {
    db,
    file,

    // Chạy fn trong một transaction (lồng nhau dùng savepoint), trả giá trị của fn.
    tx(fn) {
      return db.transaction(fn)();
    },

    // ---- projects
    insertProject({ id, preset_id, channel_id = null, title, dir, claude_session_id = null, session_started = 0, status = 'active', pipeline = null }) {
      const t = now();
      st(`INSERT INTO projects(id, preset_id, channel_id, title, dir, claude_session_id, session_started, status, pipeline, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, preset_id, channel_id, title, dir, claude_session_id, boolInt(session_started) ?? 0, status, pipeline, t, t);
      return store.getProject(id);
    },
    getProject(id) {
      return st('SELECT * FROM projects WHERE id = ?').get(id) ?? null;
    },
    listProjects() {
      return st('SELECT * FROM projects ORDER BY updated_at DESC, created_at DESC, id').all();
    },
    updateProject(id, patch) {
      update('projects', id, patch, true);
      return store.getProject(id);
    },

    // ---- steps
    insertStep({ project_id, key, name, ord, state, current_run_id = null }) {
      const id = crypto.randomUUID();
      st(`INSERT INTO steps(id, project_id, key, name, ord, state, current_run_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, project_id, key, name, ord, state, current_run_id, now());
      return store.getStepById(id);
    },
    deleteStep(id) {
      st('DELETE FROM steps WHERE id = ?').run(id);
    },
    listSteps(projectId) {
      return st('SELECT * FROM steps WHERE project_id = ? ORDER BY ord, key').all(projectId);
    },
    getStep(projectId, key) {
      return st('SELECT * FROM steps WHERE project_id = ? AND key = ?').get(projectId, key) ?? null;
    },
    getStepById(id) {
      return st('SELECT * FROM steps WHERE id = ?').get(id) ?? null;
    },
    updateStep(id, patch) {
      update('steps', id, patch, true);
      return store.getStepById(id);
    },

    // ---- runs
    insertRun({ step_id, project_id, prompt = null, feedback = null, allow_paid = false, session_id = null, pid = null }) {
      return store.tx(() => {
        let pid_ = project_id;
        if (!pid_) pid_ = store.getStepById(step_id)?.project_id;
        const n = st('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM runs WHERE step_id = ?').get(step_id).n;
        const id = crypto.randomUUID();
        st(`INSERT INTO runs(id, step_id, project_id, n, state, prompt, feedback, started_at, session_id, pid, allow_paid)
            VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`)
          .run(id, step_id, pid_, n, prompt, feedback, now(), session_id, pid, boolInt(allow_paid) ?? 0);
        return store.getRun(id);
      });
    },
    getRun(id) {
      return parseRow(st('SELECT * FROM runs WHERE id = ?').get(id));
    },
    listRunsByStep(stepId) {
      return st('SELECT * FROM runs WHERE step_id = ? ORDER BY n DESC').all(stepId).map(parseRow);
    },
    // Lượt mới nhất (n lớn nhất) của bước, hoặc null.
    latestRunByStep(stepId) {
      return parseRow(st('SELECT * FROM runs WHERE step_id = ? ORDER BY n DESC LIMIT 1').get(stepId));
    },
    // Lượt đang 'running' của dự án (mới nhất), hoặc null.
    runningRunOf(projectId) {
      return parseRow(st("SELECT * FROM runs WHERE project_id = ? AND state = 'running' ORDER BY started_at DESC LIMIT 1").get(projectId));
    },
    updateRun(id, patch) {
      update('runs', id, patch, false);
      return store.getRun(id);
    },
    listRunsByState(state) {
      return st('SELECT * FROM runs WHERE state = ? ORDER BY started_at').all(state).map(parseRow);
    },

    // ---- events
    addEvent(runId, { kind, text = null, payload = null } = {}) {
      return store.tx(() => {
        const seq = st('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM run_events WHERE run_id = ?').get(runId).s;
        const ts = now();
        const payloadJson = toJson(payload);
        const info = st('INSERT INTO run_events(run_id, seq, ts, kind, text, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
          .run(runId, seq, ts, kind, text ?? null, payloadJson);
        return { id: Number(info.lastInsertRowid), seq, ts, kind, text: text ?? null, payload: payloadJson == null ? null : safeParse(payloadJson) };
      });
    },
    listEvents(runId, afterSeq = 0, limit = 2000) {
      const after = Number.isFinite(Number(afterSeq)) ? Number(afterSeq) : 0;
      const lim = Math.max(1, Math.floor(Number(limit)) || 2000);
      return st('SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(runId, after, lim).map(parseRow);
    },

    // ---- artifacts / checks / costs
    setArtifacts(runId, list = []) {
      store.tx(() => {
        st('DELETE FROM artifacts WHERE run_id = ?').run(runId);
        const ins = st('INSERT INTO artifacts(run_id, path, kind, label, bytes, mtime) VALUES (?, ?, ?, ?, ?, ?)');
        for (const a of list) ins.run(runId, a.path, a.kind || 'other', a.label ?? null, a.bytes ?? null, toIso(a.mtime));
      });
      return store.listArtifacts(runId);
    },
    listArtifacts(runId) {
      return st('SELECT * FROM artifacts WHERE run_id = ? ORDER BY id').all(runId);
    },
    addCheck(runId, { name, cmd, passed = null, output = null, duration_ms = null }) {
      const info = st('INSERT INTO checks(run_id, name, cmd, passed, output, duration_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .run(runId, name, cmd, boolInt(passed), output, duration_ms == null ? null : Math.round(duration_ms));
      return st('SELECT * FROM checks WHERE id = ?').get(info.lastInsertRowid);
    },
    listChecks(runId) {
      return st('SELECT * FROM checks WHERE run_id = ? ORDER BY id').all(runId);
    },
    addCost(runId, { kind, units, unit_name, usd = null, note = null }) {
      const info = st('INSERT INTO costs(run_id, kind, units, unit_name, usd, note) VALUES (?, ?, ?, ?, ?, ?)')
        .run(runId, kind, Number(units) || 0, unit_name, usd == null ? null : Number(usd), note);
      return st('SELECT * FROM costs WHERE id = ?').get(info.lastInsertRowid);
    },
    listCostsByRun(runId) {
      return st('SELECT * FROM costs WHERE run_id = ? ORDER BY id').all(runId);
    },

    // Tổng token (từ runs.usage_json), USD (từ costs; null nếu không có lượt tính USD) và số lượt của dự án.
    costSummary(projectId) {
      const tok = (f) => `COALESCE(SUM(CASE WHEN json_valid(usage_json) THEN json_extract(usage_json, '$.${f}') END), 0) AS ${f}`;
      const r = st(`SELECT COUNT(*) AS runs, ${tok('input_tokens')}, ${tok('output_tokens')},
                    ${tok('cache_read_input_tokens')}, ${tok('cache_creation_input_tokens')}
                    FROM runs WHERE project_id = ?`).get(projectId);
      const usd = st('SELECT SUM(c.usd) AS usd FROM costs c JOIN runs r ON r.id = c.run_id WHERE r.project_id = ?').get(projectId).usd;
      return {
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_read_input_tokens: r.cache_read_input_tokens,
        cache_creation_input_tokens: r.cache_creation_input_tokens,
        usd: usd ?? null,
        runs: r.runs,
      };
    },
    // Token theo từng bước (runs.usage_json), theo thứ tự bước: [{key, name, runs, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}].
    usageByStep(projectId) {
      const tok = (f) => `COALESCE(SUM(CASE WHEN json_valid(r.usage_json) THEN json_extract(r.usage_json, '$.${f}') END), 0) AS ${f}`;
      return st(`SELECT s.key AS key, s.name AS name, COUNT(r.id) AS runs, ${tok('input_tokens')}, ${tok('output_tokens')},
                 ${tok('cache_read_input_tokens')}, ${tok('cache_creation_input_tokens')}
                 FROM steps s LEFT JOIN runs r ON r.step_id = s.id WHERE s.project_id = ? GROUP BY s.id ORDER BY s.ord`).all(projectId);
    },
    // Tổng units của costs kind 'claude_tokens' có run.started_at ≥ iso.
    tokensSince(iso) {
      const r = st(`SELECT COALESCE(SUM(c.units), 0) AS t FROM costs c JOIN runs r ON r.id = c.run_id
                    WHERE c.kind = 'claude_tokens' AND r.started_at >= ?`).get(toIso(iso));
      return r.t;
    },

    // Ghi token của 1 lượt ngoài bước video (source: 'assistant' | 'check').
    addTokenUsage(source, usage = {}, at = now()) {
      const n = (k) => Math.max(0, Math.round(Number(usage[k]) || 0));
      st(`INSERT INTO token_usage(at, source, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
          VALUES(?, ?, ?, ?, ?, ?)`).run(toIso(at), String(source), n('input_tokens'), n('output_tokens'), n('cache_creation_input_tokens'), n('cache_read_input_tokens'));
    },
    // Tổng token từ iso tới nay theo nguồn: steps (runs.usage_json), assistant, check → {input, output, cache, total}.
    tokenTotals(iso) {
      const since = toIso(iso);
      const tok = (f) => `COALESCE(SUM(CASE WHEN json_valid(usage_json) THEN json_extract(usage_json, '$.${f}') END), 0)`;
      const steps = st(`SELECT ${tok('input_tokens')} AS i, ${tok('output_tokens')} AS o,
                        ${tok('cache_creation_input_tokens')} + ${tok('cache_read_input_tokens')} AS c
                        FROM runs WHERE started_at >= ?`).get(since);
      const rows = st(`SELECT source, SUM(input_tokens) AS i, SUM(output_tokens) AS o,
                       SUM(cache_creation_input_tokens + cache_read_input_tokens) AS c
                       FROM token_usage WHERE at >= ? GROUP BY source`).all(since);
      const pack = (r) => {
        const input = Number(r?.i) || 0;
        const output = Number(r?.o) || 0;
        const cache = Number(r?.c) || 0;
        return { input, output, cache, total: input + output + cache };
      };
      const out = { steps: pack(steps), assistant: pack(null), check: pack(null) };
      for (const r of rows) if (r.source in out) out[r.source] = pack(r);
      return out;
    },

    // ---- YouTube (v2)
    ytChannels() {
      return st('SELECT * FROM yt_channels ORDER BY rowid').all();
    },
    ytChannel(id) {
      return st('SELECT * FROM yt_channels WHERE id = ?').get(id) ?? null;
    },
    // Ghi/cập nhật kênh đã thêm (id = mã nội bộ tạo từ tên kênh).
    ytSaveChannel({ id, yt_channel_id, title = null, status = 'ok', can_upload = false }) {
      st(`INSERT INTO yt_channels(id, yt_channel_id, title, status, can_upload, connected_at) VALUES(?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET yt_channel_id = excluded.yt_channel_id, title = excluded.title,
          status = excluded.status, can_upload = excluded.can_upload, connected_at = excluded.connected_at`)
        .run(id, yt_channel_id, title, status, boolInt(can_upload), now());
      return store.ytChannel(id);
    },
    ytSetChannelStatus(id, status) {
      st('UPDATE yt_channels SET status = ? WHERE id = ?').run(status, id);
    },
    // Xóa kênh + cache số liệu (lịch sử tải lên giữ lại).
    ytDeleteChannel(id) {
      db.transaction(() => {
        st('DELETE FROM yt_stats_cache WHERE channel_id = ?').run(id);
        st('DELETE FROM yt_channels WHERE id = ?').run(id);
      })();
    },
    ytClearCache(channelId) {
      st('DELETE FROM yt_stats_cache WHERE channel_id = ?').run(channelId);
    },
    ytCacheGet(channelId, kind) {
      const r = st('SELECT data_json, fetched_at FROM yt_stats_cache WHERE channel_id = ? AND kind = ?').get(channelId, kind);
      if (!r) return null;
      const data = safeParse(r.data_json);
      return data == null ? null : { data, fetched_at: r.fetched_at };
    },
    ytCachePut(channelId, kind, data, at = now()) {
      st(`INSERT INTO yt_stats_cache(channel_id, kind, data_json, fetched_at) VALUES(?, ?, ?, ?)
          ON CONFLICT(channel_id, kind) DO UPDATE SET data_json = excluded.data_json, fetched_at = excluded.fetched_at`)
        .run(channelId, kind, JSON.stringify(data), at);
      return at;
    },
    // Cộng đơn vị hạn mức YouTube Data API đã dùng trong ngày (ngày theo giờ Thái Bình Dương).
    ytQuotaAdd(day, units) {
      st('INSERT INTO yt_quota(day, units) VALUES(?, ?) ON CONFLICT(day) DO UPDATE SET units = units + excluded.units').run(day, units);
    },
    ytQuota(day) {
      return st('SELECT units FROM yt_quota WHERE day = ?').get(day)?.units ?? 0;
    },

    // ---- Cài đặt + phiên đăng nhập (v3)
    getSetting(key) {
      return st('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    },
    setSetting(key, value) {
      if (value === null || value === undefined) st('DELETE FROM settings WHERE key = ?').run(key);
      else st('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
    },
    // Phiên chỉ lưu băm của mã phiên; hết hạn tính theo ISO.
    addSession(idHash, expiresAt) {
      st('INSERT INTO sessions(id_hash, created_at, expires_at) VALUES(?, ?, ?)').run(idHash, now(), toIso(expiresAt));
    },
    getSession(idHash) {
      return st('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) ?? null;
    },
    deleteSession(idHash) {
      st('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
    },
    deleteSessions({ expiredBefore = null } = {}) {
      if (expiredBefore) st('DELETE FROM sessions WHERE expires_at <= ?').run(toIso(expiredBefore));
      else st('DELETE FROM sessions').run();
    },

    close() {
      if (db.open) db.close();
    },
  };
  return store;
}
