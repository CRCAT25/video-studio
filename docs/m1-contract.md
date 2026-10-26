# M1 — Implementation contract (v1, 2026-10-25)

> Binding document for every M1 module. Read together with `docs/spec.md` (§5, §6, §7, §8, §12).
> M1 = Server + SQLite + `claude -p` runner + live log stream + Overview/Step (mostly read-only) + TikTok preset.
> **Done when:** one short runs end to end from the app, with a live log.
> Not in M1 (left for M2): studio MCP, Inbox, time-based auto gates, A/B, channel rules, semaphore.

---

## 0. General conventions

- Node ≥ 20, **plain JS ESM** (`"type":"module"`), no TypeScript, no server build step.
- Dependencies already installed (do NOT run `npm install`/`npm i`): `fastify@5`, `better-sqlite3@12`, `yaml@2`,
  `tinyglobby`, dev: `react@19`, `react-dom@19`, `vite@7`, `@vitejs/plugin-react`, `playwright-core`,
  `@fontsource-variable/figtree`, `@fontsource-variable/jetbrains-mono`. Need a new package → do NOT install it, note it in the report.
- Tests: `node --test test/*.test.js` (`node:test` + `node:assert/strict`). Each test creates its own temp folder
  (`fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'))`), never touches `~/.video-studio` or the user's real folders.
- Code comments: Vietnamese, 1–2 short lines per exported function. Error messages returned to the UI: Vietnamese with diacritics.
- Times stored in the DB: ISO 8601 UTC strings (`new Date().toISOString()`).
- IDs: `crypto.randomUUID()` for runs/events…; project id = slug.
- **Never** read/write Claude credential files (`~/.claude/.credentials*`, keychain), never log email/orgId.
- The server binds **127.0.0.1** only.

## 1. Folder layout

```
server/
  cli.js        # bin: parse args, open store, load presets, create runner, buildApp, listen, print URL with token
  app.js        # buildApp(deps) → Fastify instance (tested with app.inject)
  auth.js       # token, cookie, Host/Origin checks
  sse.js        # SSE hub: subscribe(reply), broadcast(event, data)
  media.js      # GET /media/:projectId/* with Range/206
  doctor.js     # checks the claude CLI + auth status (filtered)
  paths.js      # studioHome, expandHome, safeJoin, slugify, isInside
  db.js         # openStore(file) → Store
  presets.js    # loadPresets, validatePreset, renderTemplate, loadChannels
  pipeline.js   # format catalog, suggestPipeline, preparePipeline, savePipeline, deletePipeline (§3.4)
  projects.js   # createProjects({store, presets, home}) → ProjectService (create projects, views, state transitions)
  stream.js     # normalizeLine(obj) → NormEvent[] ; parseJsonLines
  checks.js     # runChecks(...) ; builtin studio-check outputs
  runner.js     # createRunner(deps) → Runner (EventEmitter)
web/
  vite.config.js  index.html  src/main.jsx  src/App.jsx  src/api.js  src/styles/*.css  src/components/*  src/pages/*
test/
  *.test.js
  fixtures/real-stream-done.jsonl  fixtures/real-stream-denied.jsonl   # real streams, filtered
  fixtures/fake-claude.mjs                                              # fake claude for tests/e2e
  fixtures/presets/e2e-short.yaml                                       # test preset (calls no real skill)
  e2e/run.mjs                                                           # playwright-core
presets/  channels.yaml   # no built-in workflows; saved workflows ("Quy trình của tôi") + channels: ~/.video-studio/presets/
```

## 2. Paths & user folder (`server/paths.js`)

```js
export function studioHome()            // process.env.VS_HOME || ~/.video-studio ; mkdir -p ; returns an absolute path
export function expandHome(p)           // '~' or '~/x' → os.homedir()+...; anything else unchanged
export function safeJoin(root, rel)     // path.resolve(root, rel); throws Error code 'EPATH' if it escapes root,
                                        // if rel is absolute, or contains '\0'. Returns an absolute path.
export function isInside(root, abs)     // true if abs === root or lies inside root (compared after path.resolve)
export function slugify(s)              // see below
```

`slugify`: NFD → strip diacritics (`\p{M}`), `đ/Đ → d`, lowercase, every run of characters outside `[a-z0-9]` → `-`, collapse `-`,
trim leading/trailing `-`, cut to 60 characters (no trailing `-` after cutting). Empty → `du-an`.
Examples: `"Chuyến xe buýt cuối số 13"` → `chuyen-xe-buyt-cuoi-so-13`; `"Đà Lạt — mùa mưa!"` → `da-lat-mua-mua`.
Valid slug: `/^[a-z0-9][a-z0-9-]{0,63}$/`. The web has an identical copy in `web/src/lib/slug.js`.

User folder `$VS_HOME` (default `~/.video-studio`): `studio.db`, `presets/*.yaml` (saved workflows, written by the app or by hand),
`token` (no — the token lives in memory only, see §9).

## 3. Presets (`server/presets.js`)

```js
export function loadChannels(dirs)                 // reads the first channels.yaml found (repo first) → [{id,name,platform}]
export function loadPresets(dirs)                  // reads *.yaml (except channels.yaml) in each dir; → {presets: Preset[], errors: [{file, message}]}
                                                   // a later dir overrides presets with the same id from an earlier one. Never throws over one broken file.
export function validatePreset(raw, file)          // → normalized Preset, or throws Error (Vietnamese message naming the field)
export function renderTemplate(str, ctx, opts={})  // see §3.2
export function parseDuration(s)                   // '20m'→1200000, '1h'→3600000, '90s'→90000, '1h30m'; number → ms; invalid → throw
```

Preset folders in order: `<repo>/presets`, `$VS_HOME/presets` (skipped if missing). Repo root = the parent folder of `server/`.

### 3.1 Normalized preset

```js
{
  id, name, channel, format,            // format: 'short' | 'long' (default 'short')
  file,                                 // path of the yaml file
  yaml,                                 // raw text (for the Quy trình screen)
  project_dir,                          // template, still contains {slug}
  skills: [absPath],                    // expandHome applied
  vars: {k: v},
  permissions: {allow: [], ask: [], deny: []},
  defaults: {gate: {mode, after_ms?}, timeout_ms},   // timeout defaults to 2h if missing
  steps: [{
    key, name, ord,                     // key = id in yaml; ord from 0
    prompt, outputs: [glob],
    checks: [{name, run}],
    gate: {mode, after_ms?},            // mode ∈ manual|auto_if_checks|auto_after|auto ; default = defaults.gate
    cost: {service, estimate, always_ask} | null,
    resources: [], manual: bool, timeout_ms
  }]
}
```

Validation (throws if wrong): id is a slug; name; channel; `steps` ≥1; step keys are slugs and unique; `outputs` is a non-empty array of strings,
not absolute, without `..`; valid gate mode; `auto_if_checks`/`auto_after` without `checks` → error
(spec §6.4); placeholders in `prompt`, `checks[].run`, `project_dir` must belong to the variable set of §3.2 (vars.x must exist in `vars`).
Unknown fields (`foreach`, `needs`, …) are kept but ignored in M1.

### 3.2 Template

Valid placeholders: `{slug} {title} {feedback} {skill} {prev.summary} {vars.<name>}`. Any other `{...}` is **left as is**
(no error at render time — validation catches it).
- `ctx = {slug, title, feedback, skill, prev: {summary}, vars}`.
- `{feedback}` → if present: `"\n\nGóp ý của người dùng cho lượt này:\n" + feedback`; otherwise → `""`.
- `{prev.summary}` → the previous step's summary or `""`.
- `{skill}` → the first skill (absolute) or `""`.
- `opts.shell === true` (used for `checks[].run`): every substituted value is **wrapped in POSIX single quotes**
  (`'` → `'\''`). Example: `python3 {skill}/scripts/v.py` → `python3 '/Users/a b/skill'/scripts/v.py`.

### 3.3 Channels

`presets/channels.yaml` (sample): only `tiktok` — YouTube channels are added in the app (table `yt_channels`, `ytChannelList(store)` merges them into the channel list); `$VS_HOME/presets/channels.yaml` takes priority. A preset points `channel` at a channel id;
an unknown channel → still loads, the UI shows the id. `channel` is optional (missing → `null`; the channel is picked when creating a project).

### 3.4 Workflows (`server/pipeline.js`)

The repo ships no ready-made workflow. A new project starts from a **suggestion by format** or from a saved workflow.

- **Format** = `{orientation, aspect, length, duration, hd4k}`:
  `vertical` → `9:16` | `4:5`; `horizontal` → `16:9` | `21:9` (`hd4k` only for 16:9 → 3840×2160); `square` → `1:1`.
  `short` = 15–60 s (default 45 s); `long` = 3–30 min (default 10 min). Invalid → 400 `invalid_format`.
- `suggestPipeline(format)` → raw YAML-shaped object: id like `ngan-doc-9x16` / `dai-ngang-16x9-4k`, name like
  "Video ngắn dọc 9:16", `vars` (`orientation_label`, `aspect`, `resolution`, `duration`, `duration_label`) used by the prompts.
  Short = 7 steps; long = 10 steps with "Cắt Shorts" present but `enabled: false`. Paid steps always have `cost.always_ask: true`.
- `formatCatalog()` → `{orientations, aspects, lengths, steps}` (`steps` = step library for "+ Thêm bước").
- `preparePipeline(raw)` → `{raw, preset}`: drops `enabled: false` steps, strips `enabled`/`file`/`yaml`, adds the built-in
  `studio-check outputs` check to `auto_if_checks` steps without checks, then validates. Errors → `EPRESET` with `problems[]`.
- `savePipeline(home, raw, name)` → writes `<home>/presets/<slug(name)>.yaml` (`-2`, `-3`… on collision; never `channels.yaml`).
- `deletePipeline(home, id)` → deletes the file in `<home>/presets` whose YAML `id` matches; anything else → 404 `pipeline_not_found`.

**Snapshot:** `create` stores the prepared workflow as JSON in `projects.pipeline`. Editing or deleting a saved workflow never
changes existing projects. Projects created before v4 (`pipeline` NULL) still read the template by `preset_id`.

## 4. SQLite (`server/db.js`)

`openStore(file)` → `Store`. Enables `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`. Schema created via
`PRAGMA user_version` (v1). Uses prepared statements; every function is synchronous (better-sqlite3).

```sql
CREATE TABLE projects(
  id TEXT PRIMARY KEY,            -- = slug
  preset_id TEXT NOT NULL, channel_id TEXT, title TEXT NOT NULL, dir TEXT NOT NULL,
  claude_session_id TEXT,         -- uuid, created with the project
  session_started INTEGER NOT NULL DEFAULT 0,   -- 1 once the first run successfully reaches system/init
  status TEXT NOT NULL DEFAULT 'active',        -- active | running | done | failed
  pipeline TEXT,                  -- v4: JSON snapshot of the workflow used (§3.4); NULL for older projects
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE steps(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL, name TEXT NOT NULL, ord INTEGER NOT NULL,
  state TEXT NOT NULL,            -- §5
  current_run_id TEXT, updated_at TEXT NOT NULL, UNIQUE(project_id, key));
CREATE TABLE runs(
  id TEXT PRIMARY KEY, step_id TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL, n INTEGER NOT NULL,           -- the step's n-th run (1,2,…)
  state TEXT NOT NULL,            -- running | done | failed | needs_input | stopped
  prompt TEXT, feedback TEXT, started_at TEXT NOT NULL, ended_at TEXT,
  session_id TEXT, pid INTEGER, exit_code INTEGER,
  result_json TEXT,               -- structured_output (StepResult) as raw JSON
  summary TEXT, error TEXT,
  allow_paid INTEGER NOT NULL DEFAULT 0,
  progress_pct INTEGER, progress_msg TEXT,
  denials_json TEXT,              -- condensed permission_denials [{tool, input}]
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
  name TEXT NOT NULL, cmd TEXT NOT NULL, passed INTEGER,  -- 1 pass, 0 fail, NULL = skipped (not supported yet)
  output TEXT, duration_ms INTEGER);
CREATE TABLE costs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,             -- claude_tokens | <service> (e.g. elevenlabs) — M1 only records claude_tokens
  units REAL NOT NULL, unit_name TEXT NOT NULL, usd REAL, note TEXT);
CREATE INDEX ix_runs_step ON runs(step_id); CREATE INDEX ix_events_run ON run_events(run_id, seq);
```

### 4.1 Store API (synchronous; returns JS objects with snake_case column names as in the tables; each `*_json` is also returned
parsed under the key without the suffix: `result`, `denials`, `usage`, `payload`)

```js
store.db                                    // better-sqlite3 Database
store.tx(fn)                                // db.transaction(fn)()
// projects
store.insertProject({id, preset_id, channel_id, title, dir, claude_session_id})   // created_at/updated_at set automatically
store.getProject(id) / store.listProjects()           // list sorted by updated_at DESC
store.updateProject(id, patch)                        // patches columns; sets updated_at
// steps
store.insertStep({project_id, key, name, ord, state}) // id = randomUUID
store.listSteps(projectId)                            // sorted by ord
store.getStep(projectId, key) / store.getStepById(id)
store.updateStep(id, patch)                           // sets updated_at
// runs
store.insertRun({step_id, project_id, prompt, feedback, allow_paid})   // n = max(n)+1 for the step, state 'running', started_at now
store.getRun(id) / store.listRunsByStep(stepId)       // list sorted by n DESC
store.updateRun(id, patch)
store.listRunsByState(state)
// events
store.addEvent(runId, {kind, text, payload})          // seq = max(seq)+1 (in a transaction); ts now; returns {id, seq, ts, kind, text, payload}
store.listEvents(runId, afterSeq = 0, limit = 2000)   // seq > afterSeq, ascending
// artifacts / checks / costs
store.setArtifacts(runId, [{path, kind, label, bytes, mtime}])  // deletes the run's old rows, then writes
store.listArtifacts(runId)
store.addCheck(runId, {name, cmd, passed, output, duration_ms}) / store.listChecks(runId)
store.addCost(runId, {kind, units, unit_name, usd, note}) / store.listCostsByRun(runId)
store.costSummary(projectId)                          // {input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, usd, runs}
store.tokensSince(iso)                                // sum of units of 'claude_tokens' costs whose run.started_at ≥ iso
store.addTokenUsage(source, usage)                    // v5 table token_usage: tokens of turns that are not video steps ('assistant' | 'check')
store.tokenTotals(iso)                                // {steps, assistant, check} each {input, output, cache, total} since iso (steps = runs.usage_json)
store.close()
```

## 5. Step states (M1)

| state | meaning | UI buttons |
|---|---|---|
| `pending` | the previous step is not done | — |
| `ready` | ready to run | ▶ Chạy (Run) |
| `running` | a run is in progress | ■ Dừng (Stop) |
| `done` | done (Claude reported done + every check passed / or the user marked it done) | ↻ Chạy lại (Re-run) |
| `failed` | error, failed check, timeout, Claude reported failed | ↻ Re-run, Đánh dấu xong (Mark done) |
| `needs_input` | Claude reported needs_input + `questions` | Re-run with feedback (= the answer), Mark done |
| `stale` | done, but the previous step was just re-run | ↻ Re-run, Mark done |
| `manual` | a `manual: true` step whose turn has come — the user does it by hand | Mark done |

Transitions (performed by ProjectService, called by the runner):
- Create project: step 0 → `ready` (or `manual`), the rest `pending`.
- **Runnable** when state ∈ {ready, done, failed, needs_input, stale} **and** every previous step ∈ {done, stale}
  **and** the project has no `running` run **and** the lock is not held by another process. Otherwise 409.
- Start a run: step `running`, `current_run_id` = the new run; project `status=running`.
  If the step was `done`/`stale` (a re-run) → every **later** step that is `done` → `stale`
  (later steps in `ready`/`manual` → `pending`).
- A run ends (the runner calls `finishRun`):
  - `done` + every check passed (checks with `passed=NULL` do not count) → step `done`; the next step if `pending` → `ready`
    (or `manual`). A next step in `stale` stays as is. No steps left → project `done`.
  - failed check → run `failed` (error "Kiểm tra không đạt: <name>"), step `failed`.
  - Claude `needs_input` → run `needs_input`, step `needs_input`.
  - Claude `failed`, `is_error`, exit ≠ 0, no structured_output, timeout → run `failed`, step `failed`.
  - User stops → run `stopped`, the step returns to its state before the run if that was done/stale/failed/needs_input,
    otherwise `ready`. (`prev_state` is kept in the runner's memory; if lost, `ready`.)
  - After any ending: project `status` = `active` (or `done` if every step is done).
- **Mark done** (`complete`): allowed when state ∈ {ready, failed, needs_input, stale, manual} and the previous steps
  ∈ {done, stale}; step `done`, the next step `pending` → `ready`/`manual`.
- **Server restart**: a `running` run whose pid is no longer alive (`process.kill(pid, 0)` throws) or whose pid is NULL → run `failed`
  (error "Server dừng giữa chừng"), step `failed`; project `status` = `active`; delete the dead pid's lock.

## 6. ProjectService (`server/projects.js`)

```js
export function createProjects({store, presets /* () => {presets, errors} */, channels /* () => Channel[] */, home})
→ {
  create({pipeline | presetId, channelId?, title, slug?, dir?}) → ProjectView   // throws HttpError(400|404|409, message)
  list()  → OverviewItem[]
  view(id) → ProjectView | null
  stepView(id, key) → StepView | null
  canRun(id, key) → {ok: true} | {ok: false, status: 409|404|412, code, message}
  beginRun(id, key, {prompt, feedback, allowPaid}) → run      // changes states per §5 (transaction); remembers the step's prevState
                                                              // in an internal Map keyed by run.id (used on 'stopped')
  finishRun(runId, outcome)     // outcome: {state:'done'|'failed'|'needs_input'|'stopped', summary?, error?, result?, exit_code?, prevState?}
  complete(id, key) → StepView
  recoverOnStartup(isAlive = pid => bool) → number(fixed)
  writeSnapshot(id)             // writes <dir>/.studio/project.json {id, preset, title, steps:[{key,state}], updated_at}
  presetOf(id) → Preset
  estimateCost(id, key) → {service, estimate, estimate_value: number|null, unit: string} | null   // §6.1
}
export class HttpError extends Error { constructor(status, code, message) }
```

`create`:
- `pipeline` (object edited in the UI) → `preparePipeline`; errors → 400 `invalid_pipeline` with `problems[]`.
  Otherwise the saved workflow `presetId` must exist (404 `preset_not_found`). The result is stored as the snapshot (§3.4).
- `channelId` (optional) must be a known channel (400 `channel_not_found`); missing → the workflow's `channel` or `null`.
- `title` trimmed, 1–200 characters (400 `invalid_title`).
- `slug` = the given slug (must be valid, 400 `invalid_slug`) or `slugify(title)`; an existing project id → 409 `slug_taken`.
- `dir` = the given `dir` (expandHome, must be absolute after expansion, 400 `invalid_dir`) or
  `expandHome(renderTemplate(preset.project_dir, {slug}))`; a template yielding a **relative** path → resolved from `home` (`$VS_HOME`).
  A folder another project in the DB already points to → 409 `dir_taken`. An existing folder (importing an old project) is allowed.
- `mkdir -p <dir>/.studio`; `claude_session_id` = randomUUID; create steps from the preset; `writeSnapshot`.

### 6.1 Cost estimate
`cost.estimate` is a simple expression: `chars(<file>)` = number of characters (excluding leading/trailing whitespace) of a file in the project
folder (`safeJoin`), unit `ký tự`; `count(<key>)` = length of the array `project.json[<key>]`, unit `mục`; an integer → itself.
Missing file/key or an unknown expression → `estimate_value: null`. Never throws.

**ProjectView** (also the JSON returned to the UI):
```js
{ id, title, dir, preset: {id, name, format}, channel: {id, name, platform},
  status, created_at, updated_at, session_id, session_started,
  steps: [StepSummary], current: StepSummary|null,          // current = the running step, otherwise the first step not done
  progress: {done, total}, costs: store.costSummary(id),
  running_run_id: string|null }
StepSummary = { key, name, ord, state, gate_mode, has_cost: bool, manual: bool, outputs,
                run: RunSummary|null }                       // latest run
RunSummary  = { id, n, state, started_at, ended_at, summary, error, progress_pct, progress_msg, exit_code }
```
**OverviewItem** = ProjectView (`steps[].outputs` not needed).

**StepView** = `{ project: ProjectView, step: StepSummary & {prompt_template, checks:[{name,run}], cost: (preset cost + estimateCost) | null, timeout_ms},
  runs: [RunSummary + {feedback, allow_paid, result, denials, usage}] (n DESC),
  latest: {run, artifacts: [...], checks: [...], costs: [...]} | null,
  can_run: {ok, code?, message?}, resume_cmd: "cd '<dir>' && claude --resume <session_id>" | null }`
(`resume_cmd` only when `session_started=1`.)

## 7. Stream (`server/stream.js`)

```js
export function normalizeLine(obj, ctx = {})  // obj = one parsed JSON line → NormEvent[] (may be empty)
export function createLineSplitter(onLine)    // takes Buffer/string chunks, calls onLine(line) for each complete line (keeps the remainder, UTF-8 safe)
```

**NormEvent** = `{kind, text, payload}` — `text` is one short line for the log (≤ 500 characters, cut with "…").

| Source line | kind | text | payload |
|---|---|---|---|
| `system/hook_*` | (dropped) | | |
| `system/init` | `init` | `Phiên <first 8 chars of session> · model <model> · <n> tool` | `{session_id, model, cwd, permissionMode, apiKeySource, claude_code_version}` (do NOT keep `tools`, `mcp_servers`, `memory_paths`, `plugins`…) |
| `system/permission_denied` | `denied` | `Chặn <tool_name>: <message>` | `{tool_name, tool_use_id}` |
| other `system/*` | (dropped) | | |
| assistant `thinking` with text | `thinking` | the text (shortened) | — ; empty thinking → dropped |
| assistant `text` | `text` | the text | — |
| assistant `tool_use` (≠ StructuredOutput) | `tool` | `<name> <input summary>` (Bash → `command`; Edit/Write/Read → `file_path`; Glob/Grep → `pattern`; other → JSON shortened to 200) | `{id, name, input}` (input shortened: strings > 2000 characters are cut) |
| assistant `tool_use` StructuredOutput | `structured` | `Kết quả bước: <status>` | `{input}` |
| user `tool_result` | `tool_result` | shortened content (content array → joined text) | `{tool_use_id, is_error}` |
| user synthetic (`isSynthetic` or text starting with `[structured-output-enforce]`) | (dropped) | | |
| `rate_limit_event` | `rate_limit` if `status !== 'allowed'`, otherwise dropped | | `{status, resetsAt}` |
| `result` | `result` | `Hoàn tất sau <s>s · <turns> lượt · in <in+cache> / out <out> token` (+ `· $x` with an API key) | `{subtype, is_error, duration_ms, num_turns, total_cost_usd, usage:{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}, permission_denials:[{tool_name, tool_input}], structured_output, terminal_reason, result: string ≤ 2000}` |
| non-JSON line | `raw` | the line (cut) | — |
| process stderr | `stderr` | the line | — |

The runner adds its own events: `status` (Vietnamese text: "Bắt đầu lượt 2", "Đang chạy kiểm tra…", "Dừng theo yêu cầu"),
`check` (`Kiểm tra <name>: ĐẠT/TRƯỢT`, payload `{name, passed}`), `error`.
**Email/orgId never appear in events** — `normalizeLine` only picks fields from the whitelist above.

## 8. Runner (`server/runner.js`) & checks (`server/checks.js`)

```js
export const STEP_RESULT_SCHEMA            // §8.3
export const STUDIO_PROTOCOL               // stable system prompt string (§8.2)
export function buildPrompt({project, preset, step, feedback, prev})  → string    // §8.2
export function buildArgs({project, preset, step, allowPaid, model})  → string[]  // §8.1 (prompt not included)
export function createRunner({store, projects, presets, claudeBin, model, home, lockHost}) → Runner
Runner (EventEmitter):
  start(projectId, stepKey, {feedback, allowPaid}) → run    // calls projects.canRun + beginRun; spawns; returns the run immediately
  stop(runId) → bool                                        // SIGTERM, SIGKILL after 5 s; records 'stopped'
  isRunning(runId) → bool
  shutdown() → Promise                                      // stops every process when the server shuts down
  emits 'event'  ({runId, projectId, event: {seq, ts, kind, text, payload}})
  emits 'change' ({projectId})                              // whenever a step/run/project state changes
```

`claudeBin` = `process.env.VS_CLAUDE_BIN || 'claude'` (passed in by cli.js). It may be a `.mjs`/`.js` file → spawn
`process.execPath [bin, ...args]`; otherwise spawn `bin` directly. **Always `shell: false`**, `cwd = project.dir`,
`stdio: ['pipe','pipe','pipe']`, the prompt is written to **stdin** then `end()` (verified that `claude -p` reads the prompt from stdin;
the prompt is not passed positionally because the multi-value `--allowedTools` would swallow it).
`env`: inherits `process.env`, drops unneeded `VS_*`; adds NO variable containing the studio token.

### 8.1 Command-line arguments

```
-p --output-format stream-json --verbose
--session-id <project.claude_session_id>     (when session_started=0)   |   --resume <session_id>  (when =1)
--append-system-prompt <STUDIO_PROTOCOL>
--json-schema <JSON.stringify(STEP_RESULT_SCHEMA)>
--permission-mode acceptEdits
--permission-prompts none
--allowedTools <...allow>            (+ ...ask if allowPaid && step.cost)
--disallowedTools <...deny> <...ask> (ask only when NOT allowPaid or the step has no cost)
--add-dir <skill1> <skill2>…         (only skills that exist on disk)
--model <model>                      (only when the cli passes --model / VS_MODEL)
```
Empty array → the flag is dropped entirely. The order stays exactly as above. `session_started` is set to 1 on receiving the first run's `system/init`
(if that run fails before init → stays 0 so the next run still uses `--session-id`). If `--resume` fails with something like "No conversation found"
(exit ≠ 0 before init) → run `failed` with a clear error; no new session is created automatically in M1.

### 8.2 Prompt

`STUDIO_PROTOCOL` (Vietnamese, stable across runs because the CLI keeps a snapshot of the system prompt on resume):
```
Bạn đang chạy trong Video Studio — một dây chuyền làm video theo từng bước. Mỗi lượt bạn nhận đúng MỘT bước.
1. Chỉ làm đúng bước được giao trong tin nhắn; không làm trước bước sau.
2. Ghi mọi đầu ra vào thư mục dự án (cwd), đúng các đường dẫn ở mục "Đầu ra bắt buộc".
3. Không có người ngồi trả lời giữa chừng. Nếu cần người dùng quyết định, dừng lại và kết thúc với status "needs_input" kèm danh sách câu hỏi cụ thể.
4. Lệnh bị chặn quyền thì không tìm đường vòng; ghi lại trong summary.
5. Không chạy dịch vụ tốn tiền (ElevenLabs, sinh ảnh/video trả phí, upload) trừ khi tin nhắn ghi "ĐÃ DUYỆT CHI PHÍ".
6. Kết thúc bằng kết quả có cấu trúc: status, summary 1–3 câu tiếng Việt, artifacts (đường dẫn tương đối), questions, notes_for_next_step.
```

User prompt (`buildPrompt`), each line in exactly this format (fake-claude relies on the `Đầu ra bắt buộc:` line):
```
# Bước <ord+1>/<total>: <step.name> (id: <step.key>)
Dự án: <title> — slug: <slug>
Thư mục dự án (cwd): <dir>
Preset: <preset.name> (<preset.id>)
Skill: đọc <skill>/SKILL.md trước khi làm.          ← one line per existing skill; omitted if none
Đầu ra bắt buộc: <JSON.stringify(step.outputs)>

## Việc cần làm
<renderTemplate(step.prompt, ctx)>

## Góp ý của người dùng cho lượt này                  ← only when there is feedback AND the prompt template has no {feedback}
<feedback>

## Kết quả bước trước (<prev.name>)                   ← only when the previous step has a done run
<prev.summary>
Ghi chú cho bước sau: <prev.notes_for_next_step>      ← if present

ĐÃ DUYỆT CHI PHÍ: người dùng đã đồng ý chi phí dịch vụ <cost.service> cho lượt này.   ← only when allowPaid && step.cost
```
`prev` = the latest run in state `done` of the immediately preceding step (summary + result.notes_for_next_step).

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

### 8.4 Run lifecycle

1. `canRun` (409/404/412 — see §10). A step with `cost.always_ask` and `allowPaid !== true` → 412 `cost_confirm_required`
   (the body has `cost: {service, estimate, estimate_value?}`).
2. Lock `<dir>/.studio/lock` = `{pid: process.pid, host: os.hostname(), since, run_id}` created with `open(..., 'wx')`.
   Already exists: if the pid is dead, or pid = process.pid with no running run → overwrite; if another pid is alive → 409 `locked`.
3. `beginRun` → run (n). Create `<dir>/.studio/runs/<step.key>/<n>/` holding `prompt.md`, `system.md`, `args.json`
   (args without the long system prompt), `stream.jsonl` (every stdout line verbatim **except** `system/hook_*` lines,
   and `system/init` lines are written in filtered form — only the whitelisted fields of §7).
4. Spawn. Each stdout line → `normalizeLine` → `store.addEvent` → emit 'event'. stderr → `stderr` events
   (capped at 200 lines per run, then dropped). Update `runs.pid`, `runs.session_id` (from init).
5. Timeout = `step.timeout_ms` → SIGTERM, SIGKILL 5 s later; error "Hết thời gian (<minutes> phút)".
6. When the process closes: take the last `result` (if any).
   - store `usage_json`, `denials_json`, `result_json` (= structured_output), `summary` (= structured_output.summary),
     `exit_code`, `ended_at`; cost `claude_tokens`: units = input+output+cache_creation+cache_read,
     unit_name 'token', usd = total_cost_usd **only when apiKeySource ≠ 'none'** (subscription → NULL), note = model.
   - artifacts: from `structured_output.artifacts` (safe paths only: `safeJoin(dir, path)` does not throw and the file exists)
     **plus** files matching `step.outputs` (tinyglobby, cwd = dir, `dot:false`, excluding `.studio/**`) with mtime ≥ started_at − 2 s;
     merged by path; `kind` inferred from the extension (`mp4|mov|webm`→video, `wav|mp3|m4a|aac|ogg`→audio, `png|jpg|jpeg|webp|gif`→image,
     `md`→markdown, `json`→json, `srt|vtt|txt`→text, else→other); at most 200 entries.
   - If status is `done` → run checks (§8.5), `status` event "Đang chạy kiểm tra…".
   - Write `result.json` into the run folder. Call `projects.finishRun`. Delete the lock. Emit 'change'.
7. Stop (`stop`) → mark `stopping`, SIGTERM (5 s → SIGKILL); on close → `finishRun({state:'stopped'})`.

### 8.5 Checks

```js
export async function runChecks({dir, step, preset, project, run, ctx}) → [{name, cmd, passed, output, duration_ms}]
export async function checkOutputs({dir, outputs, since}) → {passed, output}
```
- `cmd` = `renderTemplate(check.run, ctx, {shell: true})`. Runs `/bin/sh -c <cmd>`, `cwd = dir`, timeout 10 minutes,
  output (stdout+stderr) keeps at most the last 20,000 characters. Exit 0 = pass.
- `studio-check outputs` (cmd equal to this string after trim) → internal: every glob matches ≥1 non-empty file with mtime ≥ since − 2 s.
  The output lists each glob: `✓ script.md (1 file)` / `✗ images/*.png: không có file mới`.
- `studio-check <other>` → `passed = null`, output "Chưa hỗ trợ ở M1 (sẽ có ở M2)".
- Results are stored with `store.addCheck` + `<run dir>/checks/<i>-<slug(name)>.log`; one `check` event each.

## 9. HTTP server (`server/app.js`, `auth.js`, `sse.js`, `media.js`, `doctor.js`, `cli.js`)

```js
export async function buildApp({store, projects, runner, presets, channels, token, webDist, doctor, logger=false}) → fastify
```
`presets` = a function returning `{presets, errors}` (the CLI caches it for 1 s; `presets.invalidate()`, if present, is called after a workflow is saved or deleted).

### 9.1 Security
- `token` = `crypto.randomBytes(24).toString('base64url')`, stored persistently in `$VS_HOME/token` by default (mode 600, see §9.6); the env `VS_TOKEN`
  overrides it (for tests/e2e). The token is **no longer printed** — it is only a hidden path for the background service/tests/dev; users sign in with a password.
- Every request checks **Host**: the hostname must be `127.0.0.1`, `localhost` or `[::1]` → otherwise 421 (DNS rebinding protection).
- A request with an `Origin` header whose origin ≠ `http://<host header>` → 403.
- Authentication (every route except static assets and `/api/health`): one of
  1. query `?t=<token>` (compared with `crypto.timingSafeEqual`) → sets cookie `vs_token=<token>; HttpOnly; SameSite=Strict; Path=/`
     and, for a GET of an HTML page, **302** to the same URL without `t` (the token does not stay in the address bar);
  2. cookie `vs_token`;
  3. header `x-studio-token`;
  4. session cookie `vs_session` (password or Google, `server/login.js`).
  Invalid: `/api/*`, `/media/*` → 401 JSON `{error:'unauthorized', message:'Phiên đăng nhập đã hết — tải lại trang để đăng nhập.'}`;
  HTML pages → 401 sign-in page: no password yet → **Tạo mật khẩu** (Create password) form, otherwise → **Mật khẩu** (Password) form
  (+ a "Đăng nhập bằng Google" button when enabled).
- Local password (default): `settings['login.password']` = `scrypt$N$r$p$salt$hash` (N=32768, r=8, p=1, 32 bytes, 16-byte salt,
  base64url; compared with `timingSafeEqual`); plaintext is never stored or logged. Minimum 8, maximum 200 characters.
  The first time, the **6-digit setup code** printed in the terminal must be entered (stops another page/process on the machine from claiming ownership); the code is stored hashed
  in `settings['login.setup']` (shared between processes, so `reset-password`/`service open` can create one while the server is running).
  5 wrong codes → 429 + a new code (printed in the terminal). 5 wrong passwords → locked for 30 seconds, doubling each time, up to 15 minutes (in memory).
  HTML forms POST urlencoded (bodyLimit 4096): `POST /auth/setup {code, password, confirm}` (password already set → 409),
  `POST /auth/password {password}`; success → **303** to `/` + cookie `vs_session`; error → the sign-in page with a message
  (400/401/409/429). Creating a password deletes every old session. Forgotten password: `video-studio reset-password` → deletes the password + every session,
  prints a new setup code.
- Google sign-in (optional, single owner): reuses the Desktop client from Google setup, PKCE loopback, scope **`openid` only**,
  reads only `sub` from the id_token (checks iss/aud/exp). Owner = sha256 of sub (table `settings`, key `login.owner`), set with the
  "Bật đăng nhập Google" button while signed in by token; another account → 403 "Tài khoản này không có quyền". 30-day sessions:
  cookie `HttpOnly; SameSite=Strict`, the DB stores only session code hashes (table `sessions`). The callback returns a meta-refresh page
  (not a 302) so the Strict cookie is sent on the next request. Disabling → removes the owner (+ every session if no password is set); the password keeps working.
  Routes: `GET /api/auth` (`{google, password: bool, via: 'session'|'token'}`), `POST /api/auth/google/enable|disable`, `POST /api/auth/logout`, `GET /auth/google`, `GET /auth/callback`.
- Every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` (no-referrer makes forms send `Origin: null`), `X-Frame-Options: DENY`,
  `Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`.
- JSON body at most 256 KB. Errors return `{error: code, message}`; 500 errors never expose a stack.

### 9.2 Endpoints

| Method & path | Returns |
|---|---|
| `GET /api/health` | `{ok:true, version, boot}` (no auth needed; `boot` changes on every server start) |
| `GET /api/doctor` | `{claude: {found, path, version}, auth: {loggedIn, authMethod, subscriptionType} \| null, node, platform, home, problems: [Vietnamese strings]}` (cached 60 s; `?refresh=1` bypasses the cache) |
| `GET /api/channels` | `Channel[]` |
| `GET /api/presets` | `{presets: [{id,name,channel,format,file,yaml,project_dir,skills,vars,permissions,defaults,steps,mine,pipeline}], errors}` — `mine` = file in `$VS_HOME/presets` (deletable) |
| `GET /api/pipeline/catalog` | `formatCatalog()` (§3.4) |
| `GET /api/pipeline/suggest?orientation=&aspect=&length=&duration=&hd4k=` | `{pipeline}` ; 400 `invalid_format` |
| `POST /api/pipelines` `{pipeline, name}` | 201 `{id, name}` ; 400 `invalid_body`/`invalid_format`/`invalid_pipeline` |
| `DELETE /api/pipelines/:id` (body `{}`) | `{ok:true}` ; 404 `pipeline_not_found` |
| `GET /api/projects` | `{projects: OverviewItem[], stats: {total, running, waiting, done, tokens_month}}` — `waiting` = number of steps in `needs_input`+`failed`+`manual`; `tokens_month` = total claude_tokens units this month |
| `POST /api/projects` `{pipeline \| presetId, title, channelId?, slug?, dir?, saveAs?}` | 201 `ProjectView` (+ `saved: {id,name} \| {error}` when `saveAs`) ; 400/404/409 |
| `GET /api/projects/:id` | `ProjectView` ; 404 |
| `GET /api/projects/:id/steps/:key` | `StepView` ; 404 |
| `POST /api/projects/:id/steps/:key/run` `{feedback?, allowPaid?}` | 202 `{run: RunSummary}` ; 409 `{error:'busy'|'locked'|'not_runnable'}` ; 412 `{error:'cost_confirm_required', cost}` ; feedback ≤ 20,000 characters |
| `POST /api/runs/:id/stop` | 200 `{ok:true}` ; 404 if not running |
| `POST /api/projects/:id/steps/:key/complete` | 200 `StepView` ; 409 |
| `GET /api/runs/:id/events?after=<seq>&limit=` | `{events: [{seq, ts, kind, text, payload}], done: bool}` |
| `GET /api/claude/usage` | `{limits: {status, type, resetsAt, windows: {five_hour, seven_day: {utilization 0..1, resetsAt}}, at} \| null, checking, tokens: {today, week} \| null, via, nextCheckAt}` (§9.7) ; 503 `usage_unavailable` |
| `POST /api/claude/usage/check` (body `{auto?}`) | same shape + `via: 'api'\|'claude'`, `nextCheckAt` (ms \| null), and `apiError` when it fell back to `claude -p` (§9.7) ; `auto: true` never falls back and returns the summary inside the cooldown ; 429 `usage_cooldown`, 502 `usage_unavailable`, 503 `claude_unavailable`, 504 `usage_timeout` |
| `GET /api/stream` | SSE (§9.3) |
| `GET /media/:projectId/*` | a file in the project folder (§9.4) |
| `GET /assets/*`, `/*` | `web/dist` (index.html for `/`); no build → an HTML page explaining `npm run build` |

### 9.3 SSE
`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`; sends `: ping` every 15 s.
Events:
- `event: change` `data: {"projectId": "..."}` — the UI reloads the project/step being viewed (150 ms client-side debounce).
- `event: log` `data: {"runId": "...", "projectId":"...", "event": {seq, ts, kind, text, payload}}`.
- `event: hello` `data: {"version": "..."}` on connect.
- `event: usage` `data: <same shape as GET /api/claude/usage>` — whenever plan limits or app token totals change.
Hub `sse.js`: `createHub()` → `{add(reply), broadcast(event, data), size(), closeAll()}`; dropped clients are removed automatically.
`buildApp` wires `runner.on('event')` → `log`, `runner.on('change')` → `change`; it broadcasts `change` itself after creating a project /
marking a step done. (`buildApp` also takes an optional `hub`; if none is passed it creates one.)
The client uses `EventSource('/api/stream')` (cookies included) and on reconnect calls `/events?after=` again to catch up.

### 9.4 Media
`GET /media/:projectId/<path>`: the project must exist; `abs = safeJoin(project.dir, path)`;
`realpath(abs)` must be inside `realpath(project.dir)` (blocks symlinks escaping); blocks any path with a segment starting
with `.` (including `.studio`, `.env`) **except** when the query has `?studio=1` and the path starts with `.studio/runs/`; regular files only.
Supports `Range: bytes=a-b` (206 + `Content-Range`, 416 when invalid), `Accept-Ranges: bytes`, `Content-Type` by extension
(md → `text/plain; charset=utf-8`, json → `application/json`, srt/vtt/txt → `text/plain; charset=utf-8`,
mp4 → video/mp4, …), `Cache-Control: no-cache`. Streamed with `fs.createReadStream`.

### 9.5 Doctor (`doctor.js`)
```js
export async function runDoctor({claudeBin}) → {claude:{found,path,version}, auth, node, platform, problems}
```
- `<claudeBin> --version` (timeout 10 s) → version. Cannot run → `found:false`, problem
  "Không tìm thấy lệnh claude. Cài Claude Code rồi mở lại app."
- `<claudeBin> auth status` (timeout 10 s) → parse JSON, **keep only** `{loggedIn, authMethod, subscriptionType}`
  (drop email, orgId, orgName, apiProvider). `loggedIn !== true` → problem
  "Claude Code chưa đăng nhập. Mở terminal, chạy `claude` rồi gõ `/login`." Parse error → `auth:null`, a minor problem.
- Sends NO prompt (spends no quota).

### 9.6 CLI (`cli.js`)
`node server/cli.js [--port 4317] [--host 127.0.0.1] [--model haiku] [--no-open] [--dev]`
- Default port 4317 (env `VS_PORT`); busy → tries increasing ports up to +20.
- Opens the store `$VS_HOME/studio.db`, `projects.recoverOnStartup()`, creates the runner, buildApp, listen.
- Prints: `Video Studio đang chạy: http://127.0.0.1:<port>/` (no token) + if no password yet: `Lần đầu: tạo mật khẩu với mã
  thiết lập <6 digits>` + the VS_HOME path. A new code (after 5 wrong tries) is also printed in the terminal.
- `reset-password`: deletes the password + every session, prints a new setup code (works while the server is running).
- `--dev`: CORS stays closed; only prints a hint to run `npm run dev:web` (Vite proxies `/api`, `/media` to the server).
- SIGINT/SIGTERM → `runner.shutdown()`, close SSE, `store.close()`, exit.
- Token: `VS_TOKEN` if set, otherwise the persistent token `$VS_HOME/token` (created the first time, mode 600); printed only with `--dev` (for Vite).
- By default only prints the link (the user clicks it). `--open` → opens the default browser (`open`/`xdg-open`/`start`), skipped with `--dev`/`--service`.
- Machine-wide command: `npm link` in the repo → type `video-studio` anywhere (package.json `bin`).
- Every mode: backs up the DB at startup and then checks every hour → `$VS_HOME/backups/studio-YYYY-MM-DD.db` (SQLite backup API,
  writes `.tmp` then renames), keeping the 7 newest copies.

#### 9.6.1 Background service (`service.js`, macOS only — launchd LaunchAgent)
`node server/cli.js service install|uninstall|restart|status|open [--port 4318]` (npm: `service:install` … , `open`).
- Plist `~/Library/LaunchAgents/com.videostudio.app.plist`: runs `node cli.js --service --port 4318 --no-open`,
  `RunAtLoad`, `KeepAlive.SuccessfulExit=false` (killed/crashed → restarted, a clean exit stays stopped), `ThrottleInterval 10`,
  env `PATH` (captured at install time, to find `claude`) + `VS_HOME`; stdout/stderr → `$VS_HOME/logs/server.log` (rotated to `.1` when >10 MB, at install/restart).
- `--service`: persistent token `$VS_HOME/token` (mode 600), the token is never printed to the log; fixed port (no fallback ports).
- `install` refuses when the service is not loaded but Video Studio already answers on the port (running from a terminal). Still 127.0.0.1 only.
- `open` opens `http://127.0.0.1:<port>/`; no password yet → prints a new setup code. `uninstall` removes the plist and keeps the data.
- Tests/smoke: `VS_SERVICE_LABEL`, `VS_SERVICE_PORT` change the service name/port — never install `com.videostudio.app` in tests.

### 9.7 Plan usage (`usage.js`)
- Every `claude -p` turn (steps, assistant, check) prints a `rate_limit_event` line; `rate_limit_info.unifiedWindows`
  (undocumented) carries `five_hour` / `seven_day` `{utilization 0..1, resetsAt (seconds)}`. `createUsage().observe(info)`
  keeps the latest one in `$VS_HOME/usage.json` (mode 600) and emits SSE `usage`. Missing windows → the UI shows "no data yet".
- The percentages are for the **whole Claude account** (also terminal / desktop use); token totals count only this app's turns.
- "Kiểm tra ngay" first calls `GET https://api.anthropic.com/api/oauth/usage` like Claude Code's `/usage` (`claude-plan.js`, no tokens):
  `authorization: Bearer <Claude Code OAuth access token>`, `anthropic-beta: oauth-2025-04-20`, 10 s timeout. Body (undocumented)
  `{five_hour, seven_day: {utilization 0..100, resets_at ISO}}` → mapped to the `rate_limit_info` shape and passed to `observe`.
  Token source: macOS Keychain item `Claude Code-credentials` (`security find-generic-password -w`, 60 s for the permission prompt),
  otherwise `~/.claude/.credentials.json`; `VS_CLAUDE_CREDENTIALS` (file) / `VS_CLAUDE_API_BASE` override both in tests — tests never
  touch the real Keychain or API. The token stays in server memory: never sent to the UI, logged or written; 401/403 → re-read once.
  The app never refreshes the token; expired → error. Cooldown 10 s.
- Fallback (no token, Keychain denied, expired, HTTP / network error, unknown body): `claude -p --output-format stream-json --verbose
  --tools '' --no-session-persistence --strict-mcp-config` with a one-word prompt in `$VS_HOME/usage-check` (a few thousand tokens),
  90 s timeout, 60 s cooldown; the response carries `apiError` and the UI shows a toast. One check at a time.
- Opening the Claude dialog sends `{auto: true}`: API only, never `claude -p`; a failed auto check does not start the cooldown, and
  after "no token" / "Keychain denied" auto checks stop until a manual check succeeds.
- UI: header pill `5h NN%` (hidden ≤ 420 px), yellow ≥ 80 % or `allowed_warning`, red at 100 % or `rejected` (+ one toast per reset time);
  the Claude account dialog shows both bars, "updated … ago", and a tokens table (today / 7 days by source; "today" = local midnight).

## 10. Error codes

| HTTP | code | When |
|---|---|---|
| 400 | `invalid_title`, `invalid_slug`, `invalid_dir`, `invalid_body` | invalid input |
| 401 | `unauthorized` | missing/wrong token |
| 403 | `forbidden_origin`, `forbidden_path` | unknown Origin; media outside the project |
| 404 | `not_found`, `preset_not_found` | |
| 409 | `slug_taken`, `dir_taken`, `busy` (the project has a running run), `locked` (another process holds the lock), `not_runnable` (previous step not done / state does not allow it) | |
| 412 | `cost_confirm_required` | a paid step not yet confirmed |
| 421 | `bad_host` | unknown Host |

## 11. Web UI (React 19 + Vite 7) — keep the "film factory" style of `prototype/index.html`

- **Fonts (10/26, matching LTShipping):** `@fontsource/be-vietnam-pro` 300/400/500 for text; digits borrowed from Figtree via
  `@font-face "VS Digits"` (unicode-range for digits and signs). Maximum weight 500. Mono = the system font (`ui-monospace`) **only**
  for logs, ids, paths. No fonts loaded from a CDN/Google (CSP `font-src 'self'`).
- Port the CSS tokens, grid background, bolted panels, conveyor belt + step cells + connecting pipes + valves/gates, header ticker, CRT terminal,
  monitor player, and light theme (`:root[data-theme="light"]`) from the prototype. Dark theme by default, the ◐ button saves to `localStorage`
  (wrapped in try/catch).
- Hash router: `#/` (Overview), `#/p/:id/:key` (Step detail), `#/quy-trinh` (Workflows; `#/presets` still works).
- **Header:** logo + the name "VIDEO STUDIO", nav (Tổng quan, Quy trình, Kênh), ticker (Claude <version> · <signed in/not>,
  number of running lines, number of steps waiting on you, clock), theme button.
- **Doctor banner** (red/amber) when `problems.length > 0`.
- **Overview:** stat cards (Projects, Running, Waiting on you, Tokens this month); each project = one production line: name, channel/preset,
  a conveyor of step cells (colored by §5 state, `running` cells animated; click a cell → Step detail), a "now doing" line
  (current step + progress_msg/summary), tokens, last update. A "＋ Dự án mới" button → two-stage modal:
  (1) pick a format (suggestion) or a saved workflow, with a step preview; (2) title, channel (optional), step editor
  (on/off, reorder, rename, gate, prompt, outputs, + add step), "Lưu làm quy trình của tôi", auto-generated slug (editable, validated),
  folder preview; Create → POST, errors shown in place.
- **Quy trình:** "Gợi ý" (format picker → preview → customize steps → save) and "Quy trình của tôi" (cards, details, Xóa with confirm). The empty state has guidance.
- **Step detail:** breadcrumb; header panel (step name, state, run n, live-counting run time, tokens this run, gate (display
  only), service cost if any); buttons ▶ Chạy / ↻ Chạy lại, ■ Dừng, Đánh dấu xong, "Mở trong terminal" (copies `resume_cmd`);
  the project's large conveyor (current step highlighted); tabs:
  - **Claude log** — CRT terminal, events styled/labelled by `kind` (init, dimmed thinking, text, tool, collapsed tool_result,
    red denied, check, status, result, stderr); auto-scrolls to the bottom unless the user scrolled up; live via SSE,
    history loaded from `/events`.
  - **Outputs** — list of artifacts (kind, label, bytes); previews: video/audio (`<video controls>` from `/media`),
    images (grid), markdown/text/json (load the content, show in `<pre>` — NEVER render HTML from a file).
  - **Checks** — each check: ĐẠT / TRƯỢT / BỎ QUA (pass/fail/skipped) + output `<pre>`.
  - **Prompt** — the prompt sent for the run being viewed + feedback.
  Side column: run result (summary, questions if needs_input, list of permission denials), a feedback box + a "Chạy lại kèm góp ý" (Re-run with feedback) button,
  list of runs (pick a run to view its log/outputs), cost (tokens).
  A step with `cost` → clicking Run opens a **cost confirmation modal** (service, estimate, a reminder "sẽ tốn tiền/credit thật") →
  Agree sends `allowPaid:true`; Cancel calls no API.
- **Presets:** list of presets, each with: a read-only conveyor of steps (name, gate, cost, checks), allow/ask/deny permissions,
  the raw YAML in a `<pre>`.
- Data: `src/api.js` (fetch with `credentials:'same-origin'`, throws errors carrying `status/code/message`), a `useSSE` hook,
  reload on `change`. No business data in localStorage.
- **Phone (390 px):** no horizontal scroll (`scrollWidth ≤ viewport`), conveyors scroll horizontally inside their own frame or
  wrap, compact header. Both themes keep readable contrast.
- No external UI library; plain CSS in `src/styles/`.
- `vite.config.js`: `root: 'web'`, `build.outDir: 'dist'` (→ `web/dist`), `base: '/'`, react plugin, dev server proxy
  `/api` + `/media` → `http://127.0.0.1:${VS_PORT||4317}` (SSE unbuffered).

## 12. Fake Claude for tests (`test/fixtures/fake-claude.mjs`)

Run as `node fake-claude.mjs <args…>`; reads the prompt from stdin and prints stream-json like the real thing (§7 sources) to stdout.
- Scenario: the content of `<cwd>/.fake-scenario` (first line) if present, otherwise env `FAKE_SCENARIO`, default `done`.
  - `done`: prints `system/init` (session_id = the value of `--session-id` or `--resume`; `apiKeySource:"none"`), assistant text,
    tool_use Write + tool_result, then creates a file for each entry in the `Đầu ra bắt buộc: [...]` line (glob `*` → `fake-1`;
    `.png` → a valid 1×1 PNG, `.wav` → a valid 0.2 s silent WAV, `.mp4` → a few fake bytes, `.json` → `{}` or
    `{"fake":true}`, anything else → text with the step title), synthetic enforce, StructuredOutput `{status:"done", summary, artifacts}`,
    `result` (subtype success, usage, num_turns, structured_output, permission_denials []).
  - `needs_input`: as above but creates no files, status `needs_input`, `questions: ["Bạn muốn giọng nam hay nữ?"]`.
  - `fail`: prints init then a `result` with `is_error:true, subtype:"error_during_execution"`, exit 1.
  - `slow`: prints init then a text "Đang làm… i" every 300 ms up to 200 times (for testing Stop/timeout), handles SIGTERM → exit 143.
  - `denied`: init, tool_use Bash, `system/permission_denied`, tool_result is_error, status done, `permission_denials` with 1 entry.
  - `crash`: prints half a JSON line then exits 2 (no result).
  - `bad_resume`: with `--resume` → prints "No conversation found with session ID" to stderr and exits 1.
- Records `argv` and the prompt in `<cwd>/.fake-calls.jsonl` (one line `{argv, prompt}` per run) so tests can check flags/prompts.
- Needs no network, never calls the real claude.

Test preset `test/fixtures/presets/e2e-short.yaml`: 4 steps (`hook` manual → outputs `[script.md]`;
`bible` auto_if_checks, check `test -s project.json`; `voice` with `cost: {service: elevenlabs, estimate: "chars(script.md)", always_ask: true}`
outputs `["audio/*.wav"]`; `deliver` check `studio-check outputs` outputs `["exports/caption.md"]`), channel `tiktok`,
`project_dir: projects/{slug}` (relative → inside `$VS_HOME`, see §6).

## 13. Required tests

Unit (`node --test`):
- `paths`: slugify (Vietnamese, odd characters, empty, long), safeJoin blocks `../`, absolute paths, `\0`.
- `presets`: the real presets in `presets/` load without errors; validation errors (missing steps, auto gate without checks, unknown placeholder,
  absolute/`..` output); renderTemplate (feedback, prev.summary, vars, shell quoting, unknown placeholders kept).
- `db`: schema creation, n increments per step, seq increments per run, costSummary, cascade.
- `projects`: create (auto slug, duplicate slug, duplicate dir, missing preset), canRun (previous step not done, busy), flow
  done → next step ready, rerun → stale, needs_input, stopped restores state, complete, recoverOnStartup.
- `stream`: the 2 real fixtures → correct sequence of kinds; no email/orgId/tools left in payloads; broken line → raw; UTF-8 splitter cutting mid-character.
- `checks`: shell exit 0/1, quoting, `studio-check outputs` (old/empty/missing files), unsupported check → null.
- `runner` (with fake-claude): correct args (session-id → resume; allow/deny by allowPaid; prompt via stdin; no positional
  prompt), done → artifacts + checks + step done + next step ready; needs_input; fail; crash; stop; timeout; denied stores denials;
  the lock blocks a second run; cost 412.
- `app` (fastify.inject): auth (missing token 401, `?t=` sets cookie + 302, header token), unknown Host 421, unknown Origin 403, the endpoints,
  media Range 206/416, blocks `../`, blocks symlinks escaping, blocks `.studio` (except `?studio=1` + `.studio/runs/`), SSE sends hello.
E2E (`npm run e2e`, playwright-core + the Chrome installed at `~/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`):
start the real server on a free port with a temporary `VS_HOME`, `VS_CLAUDE_BIN=test/fixtures/fake-claude.mjs`, a fixed `VS_TOKEN`,
the e2e preset via `$VS_HOME/presets`; create a project through the UI; run all 4 steps in order (the voice step must go through the cost confirmation modal);
see the live log; Outputs/Checks tabs; needs_input + re-run with feedback; Stop a `slow` run; switch theme; Presets screen;
390 px viewport without horizontal scroll; clean console. Screenshots go to the folder given by the `E2E_SHOTS` variable (default
`os.tmpdir()/vs-e2e-shots`).
