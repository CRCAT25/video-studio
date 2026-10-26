# M1 — Hợp đồng triển khai (v1, 25/10/2026)

> Tài liệu ràng buộc cho mọi module của M1. Đọc kèm `docs/spec.md` (§5, §6, §7, §8, §12).
> M1 = Server + SQLite + runner `claude -p` + stream log trực tiếp + Overview/Step (đọc là chính) + preset TikTok.
> **Xong khi:** chạy trọn 1 short từ app, xem log trực tiếp.
> Không có trong M1 (để M2): MCP studio, Inbox, cổng tự duyệt theo thời gian, A/B, quy tắc kênh, semaphore.

---

## 0. Quy ước chung

- Node ≥ 20, **JS thuần ESM** (`"type":"module"`), không TypeScript, không build bước server.
- Phụ thuộc đã cài sẵn (KHÔNG chạy `npm install`/`npm i`): `fastify@5`, `better-sqlite3@12`, `yaml@2`,
  `tinyglobby`, dev: `react@19`, `react-dom@19`, `vite@7`, `@vitejs/plugin-react`, `playwright-core`,
  `@fontsource-variable/figtree`, `@fontsource-variable/jetbrains-mono`. Cần gói mới → KHÔNG tự cài, ghi vào báo cáo.
- Test: `node --test test/*.test.js` (module `node:test` + `node:assert/strict`). Mỗi test tự tạo thư mục tạm
  (`fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'))`), không đụng `~/.video-studio`, không đụng thư mục thật của người dùng.
- Comment code: tiếng Việt, ngắn 1–2 dòng mỗi hàm export. Thông báo lỗi trả cho UI: tiếng Việt có dấu.
- Thời gian lưu DB: chuỗi ISO 8601 UTC (`new Date().toISOString()`).
- ID: `crypto.randomUUID()` cho run/event…; project id = slug.
- **Không bao giờ** đọc/ghi file credential Claude (`~/.claude/.credentials*`, keychain), không log email/orgId.
- Server bind **127.0.0.1** duy nhất.

## 1. Bố cục thư mục

```
server/
  cli.js        # bin: parse args, mở store, load preset, tạo runner, buildApp, listen, in URL kèm token
  app.js        # buildApp(deps) → Fastify instance (test bằng app.inject)
  auth.js       # token, cookie, kiểm Host/Origin
  sse.js        # Hub SSE: subscribe(reply), broadcast(event, data)
  media.js      # GET /media/:projectId/* có Range/206
  doctor.js     # kiểm claude CLI + auth status (đã lọc)
  paths.js      # studioHome, expandHome, safeJoin, slugify, isInside
  db.js         # openStore(file) → Store
  presets.js    # loadPresets, validatePreset, renderTemplate, loadChannels
  projects.js   # createProjects({store, presets, home}) → ProjectService (tạo dự án, view, chuyển trạng thái)
  stream.js     # normalizeLine(obj) → NormEvent[] ; parseJsonLines
  checks.js     # runChecks(...) ; builtin studio-check outputs
  runner.js     # createRunner(deps) → Runner (EventEmitter)
web/
  vite.config.js  index.html  src/main.jsx  src/App.jsx  src/api.js  src/styles/*.css  src/components/*  src/pages/*
test/
  *.test.js
  fixtures/real-stream-done.jsonl  fixtures/real-stream-denied.jsonl   # stream thật đã lọc
  fixtures/fake-claude.mjs                                              # claude giả cho test/e2e
  fixtures/presets/e2e-short.yaml                                       # preset test (không gọi skill thật)
  e2e/run.mjs                                                           # playwright-core
presets/  channels.yaml  tiktok-short.yaml   # preset/kênh riêng: ~/.video-studio/presets/
```

## 2. Đường dẫn & thư mục người dùng (`server/paths.js`)

```js
export function studioHome()            // process.env.VS_HOME || ~/.video-studio ; mkdir -p ; trả đường dẫn tuyệt đối
export function expandHome(p)           // '~' hoặc '~/x' → os.homedir()+...; còn lại giữ nguyên
export function safeJoin(root, rel)     // path.resolve(root, rel); throw Error code 'EPATH' nếu ra ngoài root,
                                        // nếu rel tuyệt đối, chứa '\0'. Trả đường dẫn tuyệt đối.
export function isInside(root, abs)     // true nếu abs === root hoặc nằm trong root (so sánh sau path.resolve)
export function slugify(s)              // xem dưới
```

`slugify`: NFD → bỏ dấu (`\p{M}`), `đ/Đ → d`, lowercase, mọi chuỗi ký tự không thuộc `[a-z0-9]` → `-`, gộp `-`,
bỏ `-` đầu/cuối, cắt 60 ký tự (không để `-` ở cuối sau khi cắt). Rỗng → `du-an`.
Ví dụ: `"Chuyến xe buýt cuối số 13"` → `chuyen-xe-buyt-cuoi-so-13`; `"Đà Lạt — mùa mưa!"` → `da-lat-mua-mua`.
Slug hợp lệ: `/^[a-z0-9][a-z0-9-]{0,63}$/`. Web có bản sao y hệt ở `web/src/lib/slug.js`.

Thư mục người dùng `$VS_HOME` (mặc định `~/.video-studio`): `studio.db`, `presets/*.yaml` (preset riêng),
`token` (không — token chỉ trong bộ nhớ, xem §9).

## 3. Preset (`server/presets.js`)

```js
export function loadChannels(dirs)                 // đọc channels.yaml đầu tiên tìm thấy (repo trước) → [{id,name,platform}]
export function loadPresets(dirs)                  // đọc *.yaml (trừ channels.yaml) trong từng dir; → {presets: Preset[], errors: [{file, message}]}
                                                   // dir sau ghi đè preset trùng id của dir trước. Không throw vì 1 file hỏng.
export function validatePreset(raw, file)          // → Preset đã chuẩn hóa, hoặc throw Error (message tiếng Việt, nêu field)
export function renderTemplate(str, ctx, opts={})  // xem §3.2
export function parseDuration(s)                   // '20m'→1200000, '1h'→3600000, '90s'→90000, '1h30m'; số → ms; sai → throw
```

Thư mục preset theo thứ tự: `<repo>/presets`, `$VS_HOME/presets` (bỏ qua nếu không có). Repo root = thư mục cha của `server/`.

### 3.1 Preset đã chuẩn hóa

```js
{
  id, name, channel, format,            // format: 'short' | 'long' (mặc định 'short')
  file,                                 // đường dẫn file yaml
  yaml,                                 // nguyên văn text (cho màn Preset)
  project_dir,                          // mẫu, vẫn chứa {slug}
  skills: [absPath],                    // đã expandHome
  vars: {k: v},
  permissions: {allow: [], ask: [], deny: []},
  defaults: {gate: {mode, after_ms?}, timeout_ms},   // timeout mặc định 2h nếu thiếu
  steps: [{
    key, name, ord,                     // key = id trong yaml; ord từ 0
    prompt, outputs: [glob],
    checks: [{name, run}],
    gate: {mode, after_ms?},            // mode ∈ manual|auto_if_checks|auto_after|auto ; mặc định = defaults.gate
    cost: {service, estimate, always_ask} | null,
    resources: [], manual: bool, timeout_ms
  }]
}
```

Validate (throw nếu sai): id dạng slug; name; channel; `steps` ≥1; step key dạng slug, duy nhất; `outputs` là mảng chuỗi
không rỗng, không tuyệt đối, không chứa `..`; gate mode hợp lệ; `auto_if_checks`/`auto_after` mà không có `checks` → lỗi
(spec §6.4); placeholder trong `prompt`, `checks[].run`, `project_dir` phải thuộc bộ biến §3.2 (vars.x phải có trong `vars`).
Trường lạ (`foreach`, `needs`, …) được giữ nhưng M1 bỏ qua.

### 3.2 Template

Placeholder hợp lệ: `{slug} {title} {feedback} {skill} {prev.summary} {vars.<tên>}`. Chuỗi `{...}` khác **giữ nguyên**
(không lỗi ở render — validate mới bắt).
- `ctx = {slug, title, feedback, skill, prev: {summary}, vars}`.
- `{feedback}` → nếu có: `"\n\nGóp ý của người dùng cho lượt này:\n" + feedback`; không có → `""`.
- `{prev.summary}` → tóm tắt bước trước hoặc `""`.
- `{skill}` → skill đầu tiên (tuyệt đối) hoặc `""`.
- `opts.shell === true` (dùng cho `checks[].run`): mỗi giá trị thay vào được **bọc nháy đơn kiểu POSIX**
  (`'` → `'\''`). Ví dụ `python3 {skill}/scripts/v.py` → `python3 '/Users/a b/skill'/scripts/v.py`.

### 3.3 Kênh

`presets/channels.yaml` (mẫu): `youtube`, `tiktok`; `$VS_HOME/presets/channels.yaml` được ưu tiên. Preset trỏ `channel` tới id kênh;
kênh không tồn tại → vẫn nạp được, UI hiện id.

## 4. SQLite (`server/db.js`)

`openStore(file)` → `Store`. Bật `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`. Schema tạo bằng
`PRAGMA user_version` (v1). Dùng prepared statement; mọi hàm đồng bộ (better-sqlite3).

```sql
CREATE TABLE projects(
  id TEXT PRIMARY KEY,            -- = slug
  preset_id TEXT NOT NULL, channel_id TEXT, title TEXT NOT NULL, dir TEXT NOT NULL,
  claude_session_id TEXT,         -- uuid, tạo khi tạo dự án
  session_started INTEGER NOT NULL DEFAULT 0,   -- 1 sau khi lượt đầu chạy thành công tới system/init
  status TEXT NOT NULL DEFAULT 'active',        -- active | running | done | failed
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE steps(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL, name TEXT NOT NULL, ord INTEGER NOT NULL,
  state TEXT NOT NULL,            -- §5
  current_run_id TEXT, updated_at TEXT NOT NULL, UNIQUE(project_id, key));
CREATE TABLE runs(
  id TEXT PRIMARY KEY, step_id TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL, n INTEGER NOT NULL,           -- lượt thứ n của bước (1,2,…)
  state TEXT NOT NULL,            -- running | done | failed | needs_input | stopped
  prompt TEXT, feedback TEXT, started_at TEXT NOT NULL, ended_at TEXT,
  session_id TEXT, pid INTEGER, exit_code INTEGER,
  result_json TEXT,               -- structured_output (StepResult) nguyên văn JSON
  summary TEXT, error TEXT,
  allow_paid INTEGER NOT NULL DEFAULT 0,
  progress_pct INTEGER, progress_msg TEXT,
  denials_json TEXT,              -- permission_denials đã rút gọn [{tool, input}]
  usage_json TEXT,                -- {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_cost_usd, api_key}
  UNIQUE(step_id, n));
CREATE TABLE run_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, payload_json TEXT,
  UNIQUE(run_id, seq));
CREATE TABLE artifacts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path TEXT NOT NULL, kind TEXT NOT NULL, label TEXT, bytes INTEGER, mtime TEXT);
CREATE TABLE checks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, cmd TEXT NOT NULL, passed INTEGER,  -- 1 đạt, 0 trượt, NULL = bỏ qua (chưa hỗ trợ)
  output TEXT, duration_ms INTEGER);
CREATE TABLE costs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,             -- claude_tokens | <service> (vd elevenlabs) — M1 chỉ ghi claude_tokens
  units REAL NOT NULL, unit_name TEXT NOT NULL, usd REAL, note TEXT);
CREATE INDEX ix_runs_step ON runs(step_id); CREATE INDEX ix_events_run ON run_events(run_id, seq);
```

### 4.1 Store API (đồng bộ; trả object JS với tên cột snake_case như bảng; `*_json` được trả kèm bản đã parse
qua key không hậu tố: `result`, `denials`, `usage`, `payload`)

```js
store.db                                    // better-sqlite3 Database
store.tx(fn)                                // db.transaction(fn)()
// projects
store.insertProject({id, preset_id, channel_id, title, dir, claude_session_id})   // created_at/updated_at tự đặt
store.getProject(id) / store.listProjects()           // list sắp updated_at DESC
store.updateProject(id, patch)                        // patch các cột; tự đặt updated_at
// steps
store.insertStep({project_id, key, name, ord, state}) // id = randomUUID
store.listSteps(projectId)                            // sắp ord
store.getStep(projectId, key) / store.getStepById(id)
store.updateStep(id, patch)                           // tự đặt updated_at
// runs
store.insertRun({step_id, project_id, prompt, feedback, allow_paid})   // n = max(n)+1 của step, state 'running', started_at now
store.getRun(id) / store.listRunsByStep(stepId)       // list sắp n DESC
store.updateRun(id, patch)
store.listRunsByState(state)
// events
store.addEvent(runId, {kind, text, payload})          // seq = max(seq)+1 (trong transaction); ts now; trả {id, seq, ts, kind, text, payload}
store.listEvents(runId, afterSeq = 0, limit = 2000)   // seq > afterSeq, tăng dần
// artifacts / checks / costs
store.setArtifacts(runId, [{path, kind, label, bytes, mtime}])  // xóa cũ của run rồi ghi
store.listArtifacts(runId)
store.addCheck(runId, {name, cmd, passed, output, duration_ms}) / store.listChecks(runId)
store.addCost(runId, {kind, units, unit_name, usd, note}) / store.listCostsByRun(runId)
store.costSummary(projectId)                          // {input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, usd, runs}
store.tokensSince(iso)                                // tổng units của costs kind 'claude_tokens' có run.started_at ≥ iso
store.close()
```

## 5. Trạng thái bước (M1)

| state | nghĩa | nút trên UI |
|---|---|---|
| `pending` | bước trước chưa xong | — |
| `ready` | sẵn sàng chạy | ▶ Chạy |
| `running` | đang có lượt chạy | ■ Dừng |
| `done` | xong (Claude báo done + mọi check đạt / hoặc người dùng đánh dấu xong) | ↻ Chạy lại |
| `failed` | lỗi, check trượt, hết giờ, Claude báo failed | ↻ Chạy lại, Đánh dấu xong |
| `needs_input` | Claude báo needs_input + `questions` | Chạy lại kèm góp ý (= câu trả lời), Đánh dấu xong |
| `stale` | đã xong nhưng bước trước vừa được chạy lại | ↻ Chạy lại, Đánh dấu xong |
| `manual` | bước `manual: true` đến lượt — người dùng tự làm | Đánh dấu xong |

Chuyển trạng thái (ProjectService thực hiện, runner gọi):
- Tạo dự án: bước 0 → `ready` (hoặc `manual`), còn lại `pending`.
- **Chạy được** khi state ∈ {ready, done, failed, needs_input, stale} **và** mọi bước trước ∈ {done, stale}
  **và** dự án không có run `running` **và** lock không bị process khác giữ. Ngược lại 409.
- Bắt đầu lượt: step `running`, `current_run_id` = run mới; project `status=running`.
  Nếu step trước đó là `done`/`stale` (chạy lại) → mọi bước **sau** đang `done` → `stale`
  (bước sau đang `ready`/`manual` → `pending`).
- Lượt kết thúc (runner gọi `finishRun`):
  - `done` + mọi check đạt (check `passed=NULL` không tính) → step `done`; bước kế tiếp đang `pending` → `ready`
    (hoặc `manual`). Bước kế đang `stale` giữ nguyên. Hết bước → project `done`.
  - check trượt → run `failed` (error "Kiểm tra không đạt: <tên>"), step `failed`.
  - Claude `needs_input` → run `needs_input`, step `needs_input`.
  - Claude `failed`, `is_error`, exit ≠ 0, không có structured_output, hết giờ → run `failed`, step `failed`.
  - Người dùng dừng → run `stopped`, step quay về trạng thái trước khi chạy nếu là done/stale/failed/needs_input,
    ngược lại `ready`. (Lưu `prev_state` trong bộ nhớ runner; nếu mất thì `ready`.)
  - Sau mọi kết thúc: project `status` = `active` (hoặc `done` nếu mọi bước done).
- **Đánh dấu xong** (`complete`): cho phép khi state ∈ {ready, failed, needs_input, stale, manual} và các bước trước
  ∈ {done, stale}; step `done`, bước kế `pending` → `ready`/`manual`.
- **Khởi động lại server**: run `running` có pid không còn sống (`process.kill(pid, 0)` lỗi) hoặc pid NULL → run `failed`
  (error "Server dừng giữa chừng"), step `failed`; project `status` = `active`; xóa lock của pid chết.

## 6. ProjectService (`server/projects.js`)

```js
export function createProjects({store, presets /* () => {presets, errors} */, channels /* () => Channel[] */, home})
→ {
  create({presetId, title, slug?, dir?}) → ProjectView   // throw HttpError(400|404|409, message)
  list()  → OverviewItem[]
  view(id) → ProjectView | null
  stepView(id, key) → StepView | null
  canRun(id, key) → {ok: true} | {ok: false, status: 409|404|412, code, message}
  beginRun(id, key, {prompt, feedback, allowPaid}) → run      // đổi trạng thái theo §5 (transaction); nhớ prevState của
                                                              // step trong Map nội bộ theo run.id (dùng khi 'stopped')
  finishRun(runId, outcome)     // outcome: {state:'done'|'failed'|'needs_input'|'stopped', summary?, error?, result?, exit_code?, prevState?}
  complete(id, key) → StepView
  recoverOnStartup(isAlive = pid => bool) → number(đã sửa)
  writeSnapshot(id)             // ghi <dir>/.studio/project.json {id, preset, title, steps:[{key,state}], updated_at}
  presetOf(id) → Preset
  estimateCost(id, key) → {service, estimate, estimate_value: number|null, unit: string} | null   // §6.1
}
export class HttpError extends Error { constructor(status, code, message) }
```

`create`:
- preset phải tồn tại (404 `preset_not_found`). `title` trim, 1–200 ký tự (400 `invalid_title`).
- `slug` = slug truyền vào (phải hợp lệ, 400 `invalid_slug`) hoặc `slugify(title)`; trùng id dự án → 409 `slug_taken`.
- `dir` = `dir` truyền vào (expandHome, phải tuyệt đối sau expand, 400 `invalid_dir`) hoặc
  `expandHome(renderTemplate(preset.project_dir, {slug}))`; mẫu cho ra đường dẫn **tương đối** → tính từ `home` (`$VS_HOME`).
  Thư mục đã có dự án khác trong DB trỏ tới → 409 `dir_taken`. Thư mục có sẵn (nhập dự án cũ) được phép.
- `mkdir -p <dir>/.studio`; `claude_session_id` = randomUUID; tạo steps theo preset; `writeSnapshot`.

### 6.1 Ước tính chi phí
`cost.estimate` là biểu thức đơn giản: `chars(<file>)` = số ký tự (không tính khoảng trắng đầu/cuối) của file trong thư mục
dự án (`safeJoin`), unit `ký tự`; `count(<key>)` = độ dài mảng `project.json[<key>]`, unit `mục`; số nguyên → chính nó.
File/key không có hoặc biểu thức lạ → `estimate_value: null`. Không bao giờ throw.

**ProjectView** (cũng là JSON trả cho UI):
```js
{ id, title, dir, preset: {id, name, format}, channel: {id, name, platform},
  status, created_at, updated_at, session_id, session_started,
  steps: [StepSummary], current: StepSummary|null,          // current = bước running, nếu không: bước đầu chưa done
  progress: {done, total}, costs: store.costSummary(id),
  running_run_id: string|null }
StepSummary = { key, name, ord, state, gate_mode, has_cost: bool, manual: bool, outputs,
                run: RunSummary|null }                       // lượt mới nhất
RunSummary  = { id, n, state, started_at, ended_at, summary, error, progress_pct, progress_msg, exit_code }
```
**OverviewItem** = ProjectView (không cần `steps[].outputs`).

**StepView** = `{ project: ProjectView, step: StepSummary & {prompt_template, checks:[{name,run}], cost: (preset cost + estimateCost) | null, timeout_ms},
  runs: [RunSummary + {feedback, allow_paid, result, denials, usage}] (n DESC),
  latest: {run, artifacts: [...], checks: [...], costs: [...]} | null,
  can_run: {ok, code?, message?}, resume_cmd: "cd '<dir>' && claude --resume <session_id>" | null }`
(`resume_cmd` chỉ khi `session_started=1`.)

## 7. Stream (`server/stream.js`)

```js
export function normalizeLine(obj, ctx = {})  // obj = 1 dòng JSON đã parse → NormEvent[] (có thể rỗng)
export function createLineSplitter(onLine)    // nhận Buffer/chuỗi từng mẩu, gọi onLine(line) cho mỗi dòng hoàn chỉnh (giữ phần dư, UTF-8 an toàn)
```

**NormEvent** = `{kind, text, payload}` — `text` là 1 dòng ngắn để hiện ở log (≤ 500 ký tự, cắt thêm "…").

| Dòng gốc | kind | text | payload |
|---|---|---|---|
| `system/hook_*` | (bỏ) | | |
| `system/init` | `init` | `Phiên <8 ký tự đầu session> · model <model> · <n> tool` | `{session_id, model, cwd, permissionMode, apiKeySource, claude_code_version}` (KHÔNG giữ `tools`, `mcp_servers`, `memory_paths`, `plugins`…) |
| `system/permission_denied` | `denied` | `Chặn <tool_name>: <message>` | `{tool_name, tool_use_id}` |
| `system/*` khác | (bỏ) | | |
| assistant `thinking` có chữ | `thinking` | chữ (rút gọn) | — ; thinking rỗng → bỏ |
| assistant `text` | `text` | chữ | — |
| assistant `tool_use` (≠ StructuredOutput) | `tool` | `<name> <tóm tắt input>` (Bash → `command`; Edit/Write/Read → `file_path`; Glob/Grep → `pattern`; khác → JSON rút gọn 200) | `{id, name, input}` (input rút gọn: chuỗi > 2000 ký tự bị cắt) |
| assistant `tool_use` StructuredOutput | `structured` | `Kết quả bước: <status>` | `{input}` |
| user `tool_result` | `tool_result` | nội dung rút gọn (mảng content → nối text) | `{tool_use_id, is_error}` |
| user synthetic (`isSynthetic` hoặc text bắt đầu `[structured-output-enforce]`) | (bỏ) | | |
| `rate_limit_event` | `rate_limit` nếu `status !== 'allowed'`, ngược lại bỏ | | `{status, resetsAt}` |
| `result` | `result` | `Hoàn tất sau <s>s · <turns> lượt · in <in+cache> / out <out> token` (+ `· $x` nếu api key) | `{subtype, is_error, duration_ms, num_turns, total_cost_usd, usage:{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}, permission_denials:[{tool_name, tool_input}], structured_output, terminal_reason, result: chuỗi ≤ 2000}` |
| dòng không phải JSON | `raw` | dòng (cắt) | — |
| stderr của process | `stderr` | dòng | — |

Runner tự thêm event: `status` (text tiếng Việt: "Bắt đầu lượt 2", "Đang chạy kiểm tra…", "Dừng theo yêu cầu"),
`check` (`Kiểm tra <tên>: ĐẠT/TRƯỢT`, payload `{name, passed}`), `error`.
**Email/orgId không bao giờ xuất hiện trong event** — `normalizeLine` chỉ chọn field theo whitelist ở trên.

## 8. Runner (`server/runner.js`) & checks (`server/checks.js`)

```js
export const STEP_RESULT_SCHEMA            // §8.3
export const STUDIO_PROTOCOL               // chuỗi system prompt ổn định (§8.2)
export function buildPrompt({project, preset, step, feedback, prev})  → string    // §8.2
export function buildArgs({project, preset, step, allowPaid, model})  → string[]  // §8.1 (không gồm prompt)
export function createRunner({store, projects, presets, claudeBin, model, home, lockHost}) → Runner
Runner (EventEmitter):
  start(projectId, stepKey, {feedback, allowPaid}) → run    // gọi projects.canRun + beginRun; spawn; trả run ngay
  stop(runId) → bool                                        // SIGTERM, sau 5 s SIGKILL; ghi 'stopped'
  isRunning(runId) → bool
  shutdown() → Promise                                      // dừng mọi process khi server tắt
  emits 'event'  ({runId, projectId, event: {seq, ts, kind, text, payload}})
  emits 'change' ({projectId})                              // mỗi khi state step/run/project đổi
```

`claudeBin` = `process.env.VS_CLAUDE_BIN || 'claude'` (cli.js truyền vào). Có thể là file `.mjs`/`.js` → spawn
`process.execPath [bin, ...args]`; ngược lại spawn `bin` trực tiếp. **Luôn `shell: false`**, `cwd = project.dir`,
`stdio: ['pipe','pipe','pipe']`, prompt ghi vào **stdin** rồi `end()` (đã kiểm chứng `claude -p` đọc prompt từ stdin;
không truyền prompt dạng positional vì `--allowedTools` nhận nhiều giá trị sẽ nuốt mất).
`env`: kế thừa `process.env`, bỏ `VS_*` không cần; KHÔNG thêm biến chứa token studio.

### 8.1 Tham số dòng lệnh

```
-p --output-format stream-json --verbose
--session-id <project.claude_session_id>     (khi session_started=0)   |   --resume <session_id>  (khi =1)
--append-system-prompt <STUDIO_PROTOCOL>
--json-schema <JSON.stringify(STEP_RESULT_SCHEMA)>
--permission-mode acceptEdits
--permission-prompts none
--allowedTools <...allow>            (+ ...ask nếu allowPaid && step.cost)
--disallowedTools <...deny> <...ask> (ask chỉ khi KHÔNG allowPaid hoặc bước không có cost)
--add-dir <skill1> <skill2>…         (chỉ skill tồn tại trên đĩa)
--model <model>                      (chỉ khi cli truyền --model / VS_MODEL)
```
Mảng rỗng → bỏ hẳn cờ. Thứ tự giữ đúng như trên. `session_started` được đặt 1 khi nhận `system/init` của lượt đầu
(với lượt đó thất bại trước init → giữ 0 để lượt sau vẫn `--session-id`). Nếu `--resume` lỗi kiểu "No conversation found"
(exit ≠ 0 trước init) → run `failed` với error rõ ràng; không tự tạo session mới trong M1.

### 8.2 Prompt

`STUDIO_PROTOCOL` (tiếng Việt, ổn định giữa các lượt vì CLI giữ snapshot system prompt khi resume):
```
Bạn đang chạy trong Video Studio — một dây chuyền làm video theo từng bước. Mỗi lượt bạn nhận đúng MỘT bước.
1. Chỉ làm đúng bước được giao trong tin nhắn; không làm trước bước sau.
2. Ghi mọi đầu ra vào thư mục dự án (cwd), đúng các đường dẫn ở mục "Đầu ra bắt buộc".
3. Không có người ngồi trả lời giữa chừng. Nếu cần người dùng quyết định, dừng lại và kết thúc với status "needs_input" kèm danh sách câu hỏi cụ thể.
4. Lệnh bị chặn quyền thì không tìm đường vòng; ghi lại trong summary.
5. Không chạy dịch vụ tốn tiền (ElevenLabs, sinh ảnh/video trả phí, upload) trừ khi tin nhắn ghi "ĐÃ DUYỆT CHI PHÍ".
6. Kết thúc bằng kết quả có cấu trúc: status, summary 1–3 câu tiếng Việt, artifacts (đường dẫn tương đối), questions, notes_for_next_step.
```

User prompt (`buildPrompt`), từng dòng đúng định dạng (fake-claude dựa vào dòng `Đầu ra bắt buộc:`):
```
# Bước <ord+1>/<total>: <step.name> (id: <step.key>)
Dự án: <title> — slug: <slug>
Thư mục dự án (cwd): <dir>
Preset: <preset.name> (<preset.id>)
Skill: đọc <skill>/SKILL.md trước khi làm.          ← một dòng cho mỗi skill tồn tại; không có thì bỏ
Đầu ra bắt buộc: <JSON.stringify(step.outputs)>

## Việc cần làm
<renderTemplate(step.prompt, ctx)>

## Góp ý của người dùng cho lượt này                  ← chỉ khi có feedback VÀ prompt template không có {feedback}
<feedback>

## Kết quả bước trước (<prev.name>)                   ← chỉ khi có run done của bước trước
<prev.summary>
Ghi chú cho bước sau: <prev.notes_for_next_step>      ← nếu có

ĐÃ DUYỆT CHI PHÍ: người dùng đã đồng ý chi phí dịch vụ <cost.service> cho lượt này.   ← chỉ khi allowPaid && step.cost
```
`prev` = run mới nhất state `done` của bước liền trước (summary + result.notes_for_next_step).

### 8.3 StepResult schema (`--json-schema`)

```json
{"type":"object","additionalProperties":false,
 "properties":{
  "status":{"type":"string","enum":["done","needs_input","failed"]},
  "summary":{"type":"string"},
  "artifacts":{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"kind":{"type":"string","enum":["video","audio","image","markdown","json","text","other"]},"label":{"type":"string"}},"required":["path"]}},
  "questions":{"type":"array","items":{"type":"string"}},
  "notes_for_next_step":{"type":"string"}},
 "required":["status","summary"]}
```

### 8.4 Vòng đời một lượt

1. `canRun` (409/404/412 — xem §10). Bước có `cost.always_ask` mà `allowPaid !== true` → 412 `cost_confirm_required`
   (body có `cost: {service, estimate, estimate_value?}`).
2. Lock `<dir>/.studio/lock` = `{pid: process.pid, host: os.hostname(), since, run_id}` tạo bằng `open(..., 'wx')`.
   Đã tồn tại: nếu pid chết hoặc pid = process.pid nhưng không có run running → ghi đè; nếu pid khác còn sống → 409 `locked`.
3. `beginRun` → run (n). Tạo `<dir>/.studio/runs/<step.key>/<n>/` chứa `prompt.md`, `system.md`, `args.json`
   (args không gồm system prompt dài), `stream.jsonl` (mọi dòng stdout nguyên văn **trừ** dòng `system/hook_*`
   và dòng `system/init` được ghi lại bản đã lọc — chỉ các field whitelist §7).
4. Spawn. Mỗi dòng stdout → `normalizeLine` → `store.addEvent` → emit 'event'. stderr → event `stderr`
   (giới hạn 200 dòng/lượt, sau đó bỏ). Cập nhật `runs.pid`, `runs.session_id` (từ init).
5. Timeout = `step.timeout_ms` → SIGTERM, 5 s sau SIGKILL; error "Hết thời gian (<phút> phút)".
6. Khi process đóng: lấy `result` cuối cùng (nếu có).
   - lưu `usage_json`, `denials_json`, `result_json` (= structured_output), `summary` (= structured_output.summary),
     `exit_code`, `ended_at`; cost `claude_tokens`: units = input+output+cache_creation+cache_read,
     unit_name 'token', usd = total_cost_usd **chỉ khi apiKeySource ≠ 'none'** (subscription → NULL), note = model.
   - artifacts: từ `structured_output.artifacts` (lọc path an toàn: `safeJoin(dir, path)` không lỗi và file tồn tại)
     **cộng** file khớp `step.outputs` (tinyglobby, cwd = dir, `dot:false`, bỏ `.studio/**`) có mtime ≥ started_at − 2 s;
     gộp theo path; `kind` suy từ đuôi (`mp4|mov|webm`→video, `wav|mp3|m4a|aac|ogg`→audio, `png|jpg|jpeg|webp|gif`→image,
     `md`→markdown, `json`→json, `srt|vtt|txt`→text, khác→other); tối đa 200 mục.
   - Nếu status `done` → chạy checks (§8.5), event `status` "Đang chạy kiểm tra…".
   - Ghi `result.json` vào thư mục lượt. Gọi `projects.finishRun`. Xóa lock. emit 'change'.
7. Dừng (`stop`) → đánh dấu `stopping`, SIGTERM (5 s → SIGKILL); khi đóng → `finishRun({state:'stopped'})`.

### 8.5 Checks

```js
export async function runChecks({dir, step, preset, project, run, ctx}) → [{name, cmd, passed, output, duration_ms}]
export async function checkOutputs({dir, outputs, since}) → {passed, output}
```
- `cmd` = `renderTemplate(check.run, ctx, {shell: true})`. Chạy `/bin/sh -c <cmd>`, `cwd = dir`, timeout 10 phút,
  output (stdout+stderr) giữ tối đa 20 000 ký tự cuối. exit 0 = đạt.
- `studio-check outputs` (cmd đúng chuỗi này sau trim) → nội bộ: mỗi glob khớp ≥1 file không rỗng, mtime ≥ since − 2 s.
  Output liệt kê từng glob: `✓ script.md (1 file)` / `✗ images/*.png: không có file mới`.
- `studio-check <khác>` → `passed = null`, output "Chưa hỗ trợ ở M1 (sẽ có ở M2)".
- Kết quả lưu `store.addCheck` + `<run dir>/checks/<i>-<slug(name)>.log`; event `check` mỗi cái.

## 9. HTTP server (`server/app.js`, `auth.js`, `sse.js`, `media.js`, `doctor.js`, `cli.js`)

```js
export async function buildApp({store, projects, runner, presets, channels, token, webDist, doctor, logger=false}) → fastify
```
`presets` = hàm trả `{presets, errors}` (đọc lại mỗi lần gọi GET /api/presets là được; M1 không cần watch).

### 9.1 Bảo mật
- `token` = `crypto.randomBytes(24).toString('base64url')`, mặc định lưu cố định ở `$VS_HOME/token` (quyền 600, xem §9.6); env `VS_TOKEN`
  ghi đè (cho test/e2e). Token **không còn in ra màn hình** — chỉ là đường ngầm cho chạy nền/test/dev; người dùng vào bằng mật khẩu.
- Mọi request kiểm **Host**: hostname phải là `127.0.0.1`, `localhost` hoặc `[::1]` → khác: 421 (chống DNS rebinding).
- Request có header `Origin` mà origin ≠ `http://<host header>` → 403.
- Xác thực (mọi route trừ asset tĩnh và `/api/health`): một trong
  1. query `?t=<token>` (so sánh `crypto.timingSafeEqual`) → set cookie `vs_token=<token>; HttpOnly; SameSite=Strict; Path=/`
     và, nếu là GET trang HTML, **302** về cùng URL bỏ `t` (token không nằm lại trên thanh địa chỉ);
  2. cookie `vs_token`;
  3. header `x-studio-token`;
  4. cookie phiên `vs_session` (mật khẩu hoặc Google, `server/login.js`).
  Không hợp lệ: `/api/*`, `/media/*` → 401 JSON `{error:'unauthorized', message:'Phiên đăng nhập đã hết — tải lại trang để đăng nhập.'}`;
  trang HTML → 401 trang đăng nhập: chưa có mật khẩu → form **Tạo mật khẩu**, có rồi → form **Mật khẩu**
  (+ nút "Đăng nhập bằng Google" khi đã bật).
- Mật khẩu cục bộ (mặc định): `settings['login.password']` = `scrypt$N$r$p$salt$hash` (N=32768, r=8, p=1, 32 byte, muối 16 byte,
  base64url; so sánh `timingSafeEqual`); không bao giờ lưu/log bản rõ. Tối thiểu 8, tối đa 200 ký tự.
  Lần đầu phải nhập **mã thiết lập 6 số** in ở terminal (chống trang/tiến trình khác trên máy chiếm quyền chủ); mã lưu băm
  `settings['login.setup']` (dùng chung giữa các tiến trình, để `reset-password`/`service open` tạo được khi server đang chạy).
  Sai mã 5 lần → 429 + mã mới (in ra terminal). Sai mật khẩu 5 lần → khóa 30 giây, gấp đôi mỗi lần, tối đa 15 phút (bộ nhớ).
  Form HTML POST urlencoded (bodyLimit 4096): `POST /auth/setup {code, password, confirm}` (đã có mật khẩu → 409),
  `POST /auth/password {password}`; thành công → **303** về `/` + cookie `vs_session`; lỗi → trang đăng nhập kèm thông báo
  (400/401/409/429). Tạo mật khẩu xóa mọi phiên cũ. Quên mật khẩu: `video-studio reset-password` → xóa mật khẩu + mọi phiên,
  in mã thiết lập mới.
- Đăng nhập Google (tùy chọn, 1 chủ): dùng lại client Desktop của Thiết lập Google, PKCE loopback, scope **chỉ `openid`**,
  chỉ đọc `sub` trong id_token (kiểm iss/aud/exp). Chủ = sha256 của sub (bảng `settings`, khóa `login.owner`), đặt bằng nút
  "Bật đăng nhập Google" khi đã vào bằng token; tài khoản khác → 403 "Tài khoản này không có quyền". Phiên 30 ngày:
  cookie `HttpOnly; SameSite=Strict`, DB chỉ lưu băm mã phiên (bảng `sessions`). Callback trả trang meta-refresh
  (không 302) để cookie Strict được gửi ở lượt sau. Tắt → xóa chủ (+ mọi phiên nếu chưa có mật khẩu); mật khẩu vẫn dùng được.
  Route: `GET /api/auth` (`{google, password: bool, via: 'session'|'token'}`), `POST /api/auth/google/enable|disable`, `POST /api/auth/logout`, `GET /auth/google`, `GET /auth/callback`.
- Mọi phản hồi: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` (no-referrer làm form gửi `Origin: null`), `X-Frame-Options: DENY`,
  `Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`.
- Body JSON tối đa 256 KB. Lỗi trả `{error: code, message}`; lỗi 500 không lộ stack.

### 9.2 Endpoint

| Method & path | Trả |
|---|---|
| `GET /api/health` | `{ok:true, version}` (không cần auth) |
| `GET /api/doctor` | `{claude: {found, path, version}, auth: {loggedIn, authMethod, subscriptionType} \| null, node, platform, home, problems: [chuỗi tiếng Việt]}` (cache 60 s; `?refresh=1` bỏ cache) |
| `GET /api/channels` | `Channel[]` |
| `GET /api/presets` | `{presets: [{id,name,channel,format,file,yaml,project_dir,skills,vars,permissions,defaults,steps}], errors}` |
| `GET /api/projects` | `{projects: OverviewItem[], stats: {total, running, waiting, done, tokens_month}}` — `waiting` = số bước `needs_input`+`failed`+`manual`; `tokens_month` = tổng units claude_tokens tháng hiện tại |
| `POST /api/projects` `{presetId, title, slug?, dir?}` | 201 `ProjectView` ; 400/404/409 |
| `GET /api/projects/:id` | `ProjectView` ; 404 |
| `GET /api/projects/:id/steps/:key` | `StepView` ; 404 |
| `POST /api/projects/:id/steps/:key/run` `{feedback?, allowPaid?}` | 202 `{run: RunSummary}` ; 409 `{error:'busy'|'locked'|'not_runnable'}` ; 412 `{error:'cost_confirm_required', cost}` ; feedback ≤ 20 000 ký tự |
| `POST /api/runs/:id/stop` | 200 `{ok:true}` ; 404 nếu không chạy |
| `POST /api/projects/:id/steps/:key/complete` | 200 `StepView` ; 409 |
| `GET /api/runs/:id/events?after=<seq>&limit=` | `{events: [{seq, ts, kind, text, payload}], done: bool}` |
| `GET /api/stream` | SSE (§9.3) |
| `GET /media/:projectId/*` | file trong thư mục dự án (§9.4) |
| `GET /assets/*`, `/*` | `web/dist` (index.html cho `/`); không có build → trang HTML hướng dẫn `npm run build` |

### 9.3 SSE
`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`; gửi `: ping` mỗi 15 s.
Sự kiện:
- `event: change` `data: {"projectId": "..."}` — UI tải lại project/step đang xem (debounce 150 ms phía client).
- `event: log` `data: {"runId": "...", "projectId":"...", "event": {seq, ts, kind, text, payload}}`.
- `event: hello` `data: {"version": "..."}` khi kết nối.
Hub `sse.js`: `createHub()` → `{add(reply), broadcast(event, data), size(), closeAll()}`; client rớt → tự gỡ.
`buildApp` nối `runner.on('event')` → `log`, `runner.on('change')` → `change`; tự broadcast `change` sau khi tạo dự án /
đánh dấu xong. (`buildApp` nhận thêm `hub` tùy chọn; không truyền thì tự tạo.)
Client dùng `EventSource('/api/stream')` (cookie đi kèm) và khi reconnect thì gọi lại `/events?after=` để bù.

### 9.4 Media
`GET /media/:projectId/<path>`: project phải tồn tại; `abs = safeJoin(project.dir, path)`;
`realpath(abs)` phải nằm trong `realpath(project.dir)` (chặn symlink thoát ra ngoài); chặn mọi path có phần tử bắt đầu
bằng `.` (gồm `.studio`, `.env`) **trừ** khi query `?studio=1` và path bắt đầu `.studio/runs/`; chỉ file thường.
Hỗ trợ `Range: bytes=a-b` (206 + `Content-Range`, 416 khi sai), `Accept-Ranges: bytes`, `Content-Type` theo đuôi
(md → `text/plain; charset=utf-8`, json → `application/json`, srt/vtt/txt → `text/plain; charset=utf-8`,
mp4 → video/mp4, …), `Cache-Control: no-cache`. Stream bằng `fs.createReadStream`.

### 9.5 Doctor (`doctor.js`)
```js
export async function runDoctor({claudeBin}) → {claude:{found,path,version}, auth, node, platform, problems}
```
- `<claudeBin> --version` (timeout 10 s) → version. Không chạy được → `found:false`, problem
  "Không tìm thấy lệnh claude. Cài Claude Code rồi mở lại app."
- `<claudeBin> auth status` (timeout 10 s) → parse JSON, **chỉ giữ** `{loggedIn, authMethod, subscriptionType}`
  (bỏ email, orgId, orgName, apiProvider). `loggedIn !== true` → problem
  "Claude Code chưa đăng nhập. Mở terminal, chạy `claude` rồi gõ `/login`." Lỗi parse → `auth:null`, problem nhẹ.
- KHÔNG gửi prompt nào (không tốn quota).

### 9.6 CLI (`cli.js`)
`node server/cli.js [--port 4317] [--host 127.0.0.1] [--model haiku] [--no-open] [--dev]`
- Cổng mặc định 4317 (env `VS_PORT`); bận → thử tăng dần tới +20.
- Mở store `$VS_HOME/studio.db`, `projects.recoverOnStartup()`, tạo runner, buildApp, listen.
- In: `Video Studio đang chạy: http://127.0.0.1:<port>/` (không token) + nếu chưa có mật khẩu: `Lần đầu: tạo mật khẩu với mã
  thiết lập <6 số>` + đường dẫn VS_HOME. Mã mới (sau 5 lần sai) cũng in ra terminal.
- `reset-password`: xóa mật khẩu + mọi phiên, in mã thiết lập mới (chạy được khi server đang chạy).
- `--dev`: CORS không mở; chỉ in thêm gợi ý chạy `npm run dev:web` (Vite proxy `/api`, `/media` sang server).
- SIGINT/SIGTERM → `runner.shutdown()`, đóng SSE, `store.close()`, exit.
- Token: `VS_TOKEN` nếu có, không thì token cố định `$VS_HOME/token` (tạo lần đầu, quyền 600); chỉ in khi `--dev` (cho Vite).
- Mặc định chỉ in link (người dùng bấm vào). `--open` → mở trình duyệt mặc định (`open`/`xdg-open`/`start`), bỏ qua khi `--dev`/`--service`.
- Lệnh toàn máy: `npm link` trong repo → gõ `video-studio` ở bất kỳ đâu (package.json `bin`).
- Mọi chế độ: sao lưu DB lúc khởi động rồi kiểm mỗi giờ → `$VS_HOME/backups/studio-YYYY-MM-DD.db` (SQLite backup API,
  ghi `.tmp` rồi đổi tên), giữ 7 bản mới nhất.

#### 9.6.1 Chạy nền (`service.js`, chỉ macOS — launchd LaunchAgent)
`node server/cli.js service install|uninstall|restart|status|open [--port 4318]` (npm: `service:install` … , `open`).
- Plist `~/Library/LaunchAgents/com.videostudio.app.plist`: chạy `node cli.js --service --port 4318 --no-open`,
  `RunAtLoad`, `KeepAlive.SuccessfulExit=false` (bị giết/lỗi → bật lại, tắt êm thì thôi), `ThrottleInterval 10`,
  env `PATH` (chụp lúc cài, để tìm `claude`) + `VS_HOME`; stdout/stderr → `$VS_HOME/logs/server.log` (xoay `.1` khi >10 MB, lúc cài/restart).
- `--service`: token cố định `$VS_HOME/token` (quyền 600), không in token ra log; cổng cố định (không thử cổng khác).
- `install` từ chối khi dịch vụ chưa nạp mà cổng đã có Video Studio trả lời (đang chạy bằng terminal). Vẫn chỉ 127.0.0.1.
- `open` mở `http://127.0.0.1:<port>/`; chưa có mật khẩu → in mã thiết lập mới. `uninstall` gỡ plist, giữ dữ liệu.
- Test/smoke: `VS_SERVICE_LABEL`, `VS_SERVICE_PORT` đổi tên/cổng dịch vụ — không bao giờ cài `com.videostudio.app` khi test.

## 10. Mã lỗi

| HTTP | code | Khi |
|---|---|---|
| 400 | `invalid_title`, `invalid_slug`, `invalid_dir`, `invalid_body` | dữ liệu vào sai |
| 401 | `unauthorized` | thiếu/sai token |
| 403 | `forbidden_origin`, `forbidden_path` | Origin lạ; media ra ngoài dự án |
| 404 | `not_found`, `preset_not_found` | |
| 409 | `slug_taken`, `dir_taken`, `busy` (dự án đang có run), `locked` (process khác giữ lock), `not_runnable` (bước trước chưa xong / state không cho) | |
| 412 | `cost_confirm_required` | bước tốn tiền chưa xác nhận |
| 421 | `bad_host` | Host lạ |

## 11. Giao diện web (React 19 + Vite 7) — giữ phong cách "nhà máy phim" của `prototype/index.html`

- **Font (26/10, theo LTShipping):** `@fontsource/be-vietnam-pro` 300/400/500 cho chữ; chữ số mượn Figtree qua
  `@font-face "VS Digits"` (unicode-range số và dấu). Độ đậm tối đa 500. Mono = font hệ thống (`ui-monospace`) **chỉ**
  cho log, id, đường dẫn. Không tải font từ CDN/Google (CSP `font-src 'self'`).
- Port CSS token, nền lưới, panel bắt vít, băng chuyền + ô bước + ống nối + van/cổng, ticker header, CRT terminal,
  monitor player, giao diện sáng (`:root[data-theme="light"]`) từ prototype. Theme mặc định tối, nút ◐ lưu `localStorage`
  (bọc try/catch).
- Router hash: `#/` (Tổng quan), `#/p/:id/:key` (Chi tiết bước), `#/presets`.
- **Header:** logo + tên "VIDEO STUDIO", nav (Tổng quan, Preset), ticker (Claude <version> · <đã đăng nhập/chưa>,
  số dây chuyền đang chạy, số bước chờ bạn, đồng hồ), nút theme.
- **Banner doctor** (đỏ/ambers) khi `problems.length > 0`.
- **Tổng quan:** thẻ số liệu (Dự án, Đang chạy, Chờ bạn, Token tháng này); mỗi dự án = 1 dây chuyền: tên, kênh/preset,
  băng chuyền các ô bước (màu theo state §5, ô `running` có hiệu ứng chạy; bấm ô → Chi tiết bước), dòng "đang làm"
  (bước hiện tại + progress_msg/summary), token, cập nhật lần cuối. Nút "＋ Dự án mới" → modal: chọn preset (nhóm theo
  kênh), tiêu đề, slug tự sinh (sửa được, kiểm hợp lệ), xem trước thư mục (`project_dir` thay `{slug}`), xem trước các
  bước; Tạo → POST, lỗi 409 hiện tại chỗ. Trạng thái rỗng có hướng dẫn.
- **Chi tiết bước:** crumb; panel đầu (tên bước, state, lượt n, thời gian chạy đếm sống, token lượt này, cổng (chỉ hiển
  thị), chi phí dịch vụ nếu có); nút ▶ Chạy / ↻ Chạy lại, ■ Dừng, Đánh dấu xong, "Mở trong terminal" (copy `resume_cmd`);
  băng chuyền lớn của dự án (bước hiện tại nổi bật); tab:
  - **Nhật ký Claude** — terminal CRT, sự kiện theo `kind` có màu/nhãn riêng (init, thinking mờ, text, tool, tool_result
    thu gọn, denied đỏ, check, status, result, stderr); tự cuộn xuống trừ khi người dùng cuộn lên; nhận live qua SSE,
    nạp lịch sử qua `/events`.
  - **Đầu ra** — danh sách artifact (kind, label, bytes); xem trước: video/audio (`<video controls>` từ `/media`),
    ảnh (lưới), markdown/text/json (tải nội dung, hiện `<pre>` — KHÔNG render HTML từ file).
  - **Kiểm tra** — từng check: ĐẠT / TRƯỢT / BỎ QUA + output `<pre>`.
  - **Prompt** — prompt đã gửi của lượt đang xem + feedback.
  Cột bên: kết quả lượt (summary, câu hỏi nếu needs_input, danh sách bị chặn quyền), ô góp ý + nút "Chạy lại kèm góp ý",
  danh sách lượt (chọn lượt để xem log/đầu ra của lượt đó), chi phí (token).
  Bước có `cost` → bấm Chạy mở **modal xác nhận chi phí** (dịch vụ, ước tính, lời nhắc "sẽ tốn tiền/credit thật") →
  Đồng ý gửi `allowPaid:true`; Hủy thì không gọi API.
- **Preset:** danh sách preset, mỗi cái: băng chuyền đọc-only các bước (tên, gate, cost, checks), quyền allow/ask/deny,
  YAML gốc trong `<pre>`.
- Dữ liệu: `src/api.js` (fetch `credentials:'same-origin'`, ném lỗi có `status/code/message`), `useSSE` hook,
  tải lại theo `change`. Không lưu dữ liệu nghiệp vụ vào localStorage.
- **Điện thoại (390 px):** không cuộn ngang (`scrollWidth ≤ viewport`), băng chuyền cuộn ngang bên trong khung riêng hoặc
  xuống dòng, header gọn. Cả hai theme đạt tương phản đọc được.
- Không dùng thư viện UI ngoài; CSS thuần trong `src/styles/`.
- `vite.config.js`: `root: 'web'`, `build.outDir: 'dist'` (→ `web/dist`), `base: '/'`, plugin react, dev server proxy
  `/api` + `/media` → `http://127.0.0.1:${VS_PORT||4317}` (SSE không buffer).

## 12. Claude giả cho test (`test/fixtures/fake-claude.mjs`)

Chạy bằng `node fake-claude.mjs <args…>`, đọc prompt từ stdin, in stream-json giống thật (§7 nguồn) ra stdout.
- Kịch bản: nội dung file `<cwd>/.fake-scenario` (dòng đầu) nếu có, ngược lại env `FAKE_SCENARIO`, mặc định `done`.
  - `done`: in `system/init` (session_id = giá trị `--session-id` hoặc `--resume`; `apiKeySource:"none"`), assistant text,
    tool_use Write + tool_result, rồi tạo file cho từng mục trong dòng `Đầu ra bắt buộc: [...]` (glob `*` → `fake-1`;
    đuôi `.png` → PNG 1×1 hợp lệ, `.wav` → WAV 0,2 s im lặng hợp lệ, `.mp4` → vài byte giả, `.json` → `{}` hoặc
    `{"fake":true}`, còn lại → text có tiêu đề bước), synthetic enforce, StructuredOutput `{status:"done", summary, artifacts}`,
    `result` (subtype success, usage, num_turns, structured_output, permission_denials []).
  - `needs_input`: như trên nhưng không tạo file, status `needs_input`, `questions: ["Bạn muốn giọng nam hay nữ?"]`.
  - `fail`: in init rồi `result` với `is_error:true, subtype:"error_during_execution"`, exit 1.
  - `slow`: in init rồi mỗi 300 ms một text "Đang làm… i" tới 200 lần (để test Dừng/timeout), xử lý SIGTERM → exit 143.
  - `denied`: init, tool_use Bash, `system/permission_denied`, tool_result is_error, status done, `permission_denials` 1 mục.
  - `crash`: in nửa dòng JSON rồi exit 2 (không có result).
  - `bad_resume`: nếu có `--resume` → in stderr "No conversation found with session ID" và exit 1.
- Ghi lại `argv` và prompt vào `<cwd>/.fake-calls.jsonl` (mỗi lượt 1 dòng `{argv, prompt}`) để test kiểm cờ/prompt.
- Không cần mạng, không gọi claude thật.

Preset test `test/fixtures/presets/e2e-short.yaml`: 4 bước (`hook` manual → outputs `[script.md]`;
`bible` auto_if_checks, check `test -s project.json`; `voice` có `cost: {service: elevenlabs, estimate: "chars(script.md)", always_ask: true}`
outputs `["audio/*.wav"]`; `deliver` check `studio-check outputs` outputs `["exports/caption.md"]`), channel `tiktok`,
`project_dir: projects/{slug}` (tương đối → nằm trong `$VS_HOME`, xem §6).

## 13. Kiểm thử bắt buộc

Unit (`node --test`):
- `paths`: slugify (tiếng Việt, ký tự lạ, rỗng, dài), safeJoin chặn `../`, tuyệt đối, `\0`.
- `presets`: nạp 3 preset thật trong `presets/` không lỗi; lỗi validate (thiếu steps, gate tự mà không check, placeholder lạ,
  output tuyệt đối/`..`); renderTemplate (feedback, prev.summary, vars, shell quoting, placeholder lạ giữ nguyên).
- `db`: tạo schema, n tăng theo step, seq tăng theo run, costSummary, cascade.
- `projects`: create (slug tự sinh, trùng slug, trùng dir, preset thiếu), canRun (bước trước chưa xong, busy), luồng
  done → bước kế ready, rerun → stale, needs_input, stopped khôi phục state, complete, recoverOnStartup.
- `stream`: 2 fixture thật → đúng chuỗi kind; không còn email/orgId/tools trong payload; dòng hỏng → raw; splitter UTF-8 cắt giữa ký tự.
- `checks`: shell exit 0/1, quoting, `studio-check outputs` (file cũ/rỗng/thiếu), check chưa hỗ trợ → null.
- `runner` (với fake-claude): args đúng (session-id → resume; allow/deny theo allowPaid; prompt qua stdin; không có prompt
  positional), done → artifacts + checks + step done + bước kế ready; needs_input; fail; crash; stop; timeout; denied lưu denials;
  lock chặn lượt thứ 2; cost 412.
- `app` (fastify.inject): auth (thiếu token 401, `?t=` set cookie + 302, header token), Host lạ 421, Origin lạ 403, các endpoint,
  media Range 206/416, chặn `../`, chặn symlink ra ngoài, chặn `.studio` (trừ `?studio=1` + `.studio/runs/`), SSE gửi hello.
E2E (`npm run e2e`, playwright-core + Chrome đã cài ở `~/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`):
khởi server thật trên cổng trống với `VS_HOME` tạm, `VS_CLAUDE_BIN=test/fixtures/fake-claude.mjs`, `VS_TOKEN` cố định,
preset e2e qua `$VS_HOME/presets`; tạo dự án qua UI; chạy lần lượt cả 4 bước (bước voice phải qua modal xác nhận chi phí);
thấy log live; tab Đầu ra/Kiểm tra; needs_input + chạy lại kèm góp ý; Dừng một lượt `slow`; đổi theme; màn Preset;
viewport 390 px không cuộn ngang; console sạch. Chụp ảnh màn hình vào thư mục do biến `E2E_SHOTS` chỉ định (mặc định
`os.tmpdir()/vs-e2e-shots`).
