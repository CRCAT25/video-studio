# Video Studio — Design document (v0.1, 2026-10-25)

> Working name. A **local**, **open-source** app that holds a video-making pipeline step by step and hands each step to
> **the Claude Code already signed in on the user's machine**. The user sees which step a project is on, what Claude is doing,
> and decides which steps need manual approval and which may approve themselves.

---

## 1. Problems to solve

Drawn from ~3 weeks of running 3 channels (2 YouTube + TikTok) with Claude Code in the terminal:

| Pain | Real example |
|---|---|
| No overview: which episode is on which step | Had to read memory / `ls exports/` to know whether Episode 02 had its final render |
| Parallel sessions duplicate work | On 10/08 nearly spent ~612 ElevenLabs credits on a video already finished in another session |
| Every project writes its own review page | `review_server.py` on :8765, :8766, :8767… one copy per project |
| Approval gates live only in instructions | "review on localhost before rendering", "ask before spending credits" — Claude has to remember |
| User feedback turns into scattered rules | memory feedback + SKILL.md + a "Style" Google Sheet |
| No idea how much was spent | ElevenLabs credits, render hours, Claude tokens |
| Publishing schedule & delivery done by hand | one video every 2 days at 11:30, copy to `videos/<Title>/` + `cmp` |

**Goal:** one screen for the whole production line; approval gates and costs are **rules of the system**,
not instructions in a prompt; every pipeline is described by a **preset** so others can reuse it.

**Non-goals (V1):** no rendering by the app itself (Claude + the preset's scripts do it), no cloud storage,
no serving multiple users from one server, no automatic YouTube upload.

---

## 2. Design principles

1. **Bring your own Claude.** The app never asks for or stores claude.ai credentials. It calls the `claude` CLI the
   user has already signed in to (`claude /login`, Pro/Max plan) or configured with `ANTHROPIC_API_KEY`. See section 11.
2. **Disk is the source of truth.** Project files stay where they are (`<projects root>/<slug>`); the app only
   adds a `.studio/` folder inside the project. Remove the app and the project still works with Claude in the terminal.
3. **Each step = one Claude turn with a clear contract:** inputs, outputs, checks, approval gate.
4. **Money always asks.** Steps/tools that spend money outside (ElevenLabs, image/video generation, uploads) never approve themselves,
   even in fully automatic mode — unless the user sets a capped auto-approve budget.
5. **Something playable fast.** A low-res draft with voice first, polish later (lesson "test short speed first").
6. **Localhost only.** The server binds `127.0.0.1`, with a random token in the URL on first open.

---

## 3. Concepts

| Concept | Meaning |
|---|---|
| **Channel** | A publishing channel (YouTube/TikTok) with a root folder, style bible and publishing schedule |
| **Preset** | A YAML file describing a pipeline: steps, prompts, approval gates, checks, costs. A channel can have several presets (long video, Short) |
| **Project** | One specific video, created from a preset, with a slug + folder |
| **Step** | One link in a project's pipeline (Script, Voice, Draft, Review, Final, Delivery…) |
| **Run** | One time Claude performs a step. Rejected → a new run with feedback. Every run is kept |
| **Artifact** | A file a step produces: video, per-line audio, images, markdown, json. Versioned per run |
| **Gate** | The condition for a step to count as done: manual / auto if checks pass / auto after X minutes / automatic |
| **Approval** | Something waiting on the user: approve a step, answer a question, allow a tool, approve a cost |
| **Rule** | A line in the channel's style bible, usually born from feedback on a rejection |
| **CostEntry** | Claude tokens, external service credits, render minutes — attached to a run |

---

## 4. Screens

### 4.1 Overview
- Top bar: number of items **waiting on you**, number of running runners, this month's cost, **New project** button.
- Filter by channel. One row per project: name, channel, preset, **step strip** (one cell per step, colored by state),
  current step + a one-line description ("Rendering chunk 3/4 — ~6 minutes left"), cost, last update.
- Click a step cell → Step detail.
- Right column (desktop) / tab (phone): a compact **Inbox**.

### 4.2 Inbox
Collects every open Approval, sorted by urgency:
1. **Allow tool** (Claude is blocked waiting — e.g. "Generate ElevenLabs 18 lines, ~1,230 credits").
2. **Claude's questions** (answer form: pick an option / free text).
3. **Approve step** (quick look at outputs, Approve / Reject + feedback).
4. **Approve cost before a step** (steps with `cost.always_ask`).

Each item: project, step, how long it has waited, auto-approve deadline (if the gate is `auto_after`).

### 4.3 Step detail
- **Header:** step name, state, run N, run time, this run's cost, Re-run / Stop / Skip buttons.
- **Outputs tab:** video player (seekable, notes at timestamps → feedback carries timecode + still automatically), list of dialogue
  lines with a play button per line, grid of stills, markdown/json viewer. **A/B compare** between 2 runs (videos side by side, audio
  take 1/take 2).
- **Log tab:** real-time stream from Claude (`stream-json`): short thoughts, tool calls (Bash/Edit/Write), changed files,
  progress Claude reports through `studio_progress`.
- **Checks tab:** results of check commands (`qa_export.py`, `cammotion.py`, `validate_project.py`…): PASS/FAIL + log.
- **Gate tab:** change the gate mode for this step (overrides the preset for this project only).
- **Feedback box:** Approve / Reject. On reject: a reason field + timestamp → asks **"Save as a channel rule?"**
  (see 4.5). The feedback becomes the prompt for the next run, in the same Claude session (`--resume`).

### 4.4 New project
Pick channel → preset → enter an idea / pick from the **Idea bank** → slug + working title → preview the steps and gates →
Create. The app creates the folder (or attaches to an existing one — **import an old project**) and writes `.studio/project.json`.

### 4.5 Channels & Rules
- Channel info, root folder, bundled skills, publishing schedule.
- **Style bible**: a list of rules (group, text, reason, source: "from feedback on Episode 02 run 8"). Each rule can be toggled.
  Enabled rules are appended to the system prompt of every run on the channel.
- Export/import `rules.md` to sync with existing SKILL.md files.

### 4.5b YouTube channels (real connection)
The **Channels** tab (`#/channels`) starts empty. The user clicks **+ Thêm kênh** (Add channel), signs in to that channel's Google account and picks the channel on Google's screen; the app reads the channel name and saves it to the `yt_channels` table. YouTube channels are not declared in `channels.yaml` (that file only holds other channels, e.g. TikTok). The internal channel id = the channel name without diacritics (`bep-nha-minh`), with `-2` appended on collision. Adding an existing channel again → 409 `yt_dup`.

- **Google setup** (`#/channels/setup`), done once: the user creates their own Google Cloud project, enables YouTube Data API v3 + YouTube Analytics API, sets the consent screen to *External* and **In production** (in Testing mode tokens expire after 7 days), fills in a homepage + privacy policy (Google requires them before Publish; the app pre-fills the GitHub link and the repo's `PRIVACY.md`, plus the authorized domain `github.com`), creates a **Desktop app** client, then pastes `client_secret.json` into the app. Web-type clients are rejected.
- **Add / reconnect**: one OAuth per channel (reconnect only when Google forces a new sign-in; the same channel must be picked, otherwise → 409 `yt_wrong_channel`), opened in the chosen Chrome profile (or the default browser). Uses loopback `http://127.0.0.1:<port>/api/youtube/oauth/callback` + PKCE S256 + a single-use `state`; the callback route is public (another Chrome profile may not have the app's cookie). Read scopes: `youtube.readonly`, `yt-analytics.readonly`; `youtube.upload` + `youtube.force-ssl` are added when uploads are enabled. No email/profile scope is requested.
- **Secrets**: the client secret and refresh tokens live only on the server: Keychain on macOS (`security -i`, hex value via stdin), a mode-600 file elsewhere. Never sent to the browser or logged. **Xóa kênh** (Remove channel) = revoke at Google + delete the token, DB row and cache.
- **Statistics**: subscribers, total views; last 28 days (views, watch minutes, net subscribers, daily chart); sortable video table. SQLite cache for 6 hours, a **Làm mới** (Refresh) button calls Google again. Analytics usually lags 1–2 days.
- **Quota**: ~10,000 points/day by the Los Angeles calendar day (resets around 14:00–15:00 Vietnam time); the app counts and shows how many are used. Uploading one video ≈ 1,600 points.
- **Google's limits**: the app is not verified → an "unverified app" warning (Advanced → Go to…); videos uploaded from an unaudited project are always Private; setting thumbnails needs a phone-verified channel.
- **SSE `youtube`**: emitted whenever the state changes, including after every statistics fetch → the UI reloads only the *state*, not the statistics (avoids a loop).
- **Tests**: `VS_SECRETS=file` (never touches the real Keychain) and `VS_GOOGLE_BASE=<fake server>` (`test/fixtures/fake-google.mjs`).
- **Phase 2 (not done)**: pick each channel's delivered-videos folder in the app, upload videos from it (reading `publish.md`), always Private, `madeForKids=false`, resumable upload with progress, then thumbnails / captions / playlists.

### 4.6 Presets
View/edit YAML, view the step diagram, validate (schema), duplicate a preset.

### 4.7 Calendar & Idea bank (V2)
- Monthly calendar: slots per channel rules (e.g. a long video every 2 days; 2 Shorts on the days in between).
  Drag projects into slots; warn about slots in the next 7 days with no project at the Final step.
- Idea bank: 💡 Idea → ✍️ Writing → ✅ Script done → 🎬 Editing → 📺 Published. Import from Google Sheets/markdown.

### 4.8 Costs
By month / channel / project / type: Claude tokens (subscription: tokens & run count only; API key: USD), ElevenLabs
credits, render minutes. Budget cap per channel/month.

---

## 5. Step state machine

```
pending ──(previous step done)──▶ ready ──(runner picks up)──▶ running
running ──studio_ask──────────▶ needs_input ──(answer)──▶ running
running ──sensitive tool──────▶ needs_permission ──(allow/deny)──▶ running
running ──done, checks run────▶ checking ──▶ awaiting_review (manual gate)
                                         └─▶ approved (auto gate, checks pass)
awaiting_review ──Approve──▶ approved
awaiting_review ──Reject + feedback──▶ ready (run N+1)
running ──error/timeout──▶ failed ──Re-run──▶ ready
* ──Skip──▶ skipped
approved ──(previous step re-run & its outputs changed)──▶ stale  (tell the user, do not re-run automatically)
```

- A project has **one runner** at a time (lock `.studio/lock` with pid + host). Another terminal session that wants
  to work on the same project sees the lock (an optional `SessionStart` hook lets Claude in the terminal know too).
- Steps of different projects run in parallel, but heavy resources go through a **semaphore**: `render` (4 jobs by default on a 16 GB machine),
  `gpu`, `network-heavy`. A preset declares `resources: [render]`.

### Gates

| Mode | Behavior |
|---|---|
| `manual` | Always waits for the user |
| `auto_if_checks` | Approves itself if every `checks` entry PASSes, otherwise waits for the user |
| `auto_after` | Waits for the user up to `after` (e.g. 30m), then approves itself (only if checks PASS) |
| `auto` | Approves immediately |

Override order: preset → channel → project → global "autopilot mode" (Off / Cautious / Aggressive —
raises every non-money `manual` to `auto_if_checks`). **Steps with a `cost`, or tools in
`always_ask`, are never raised.**

---

## 6. Claude Code integration

### 6.1 One run

```bash
claude -p "<step prompt + feedback>" \
  --output-format stream-json --verbose \
  --session-id <uuid>            # first run of the project; later runs: --resume <uuid>
  --append-system-prompt-file .studio/run/<run>/system.md \  # studio protocol + channel rules
  --add-dir <skill folder> \
  --mcp-config .studio/run/<run>/mcp.json \                    # the app's "studio" MCP server
  --permission-mode acceptEdits \
  --permission-prompt-tool mcp__studio__permission \
  --json-schema '<StepResult schema>'
```

- `cwd` = the project folder. The app reads the stream line by line as JSON → stores it in `runs.log` + pushes SSE/WebSocket to the UI.
- The final `result` message provides: `session_id`, `usage`, `total_cost_usd` (API key), `duration_ms`, and
  `structured_output` matching the StepResult schema.
- **One Claude session per project** (resumed across steps) so Claude remembers context; when the session grows too long, the app starts
  a new session with the summary `.studio/summary.md` (Claude writes it at the end of each step).
- API key mode: add `--max-budget-usd` per the step's cap.

### 6.2 Studio protocol (appended system prompt)

Claude is told to:
1. Do only step `{step.name}`; outputs must be within `{step.outputs}`.
2. Report progress with the tool `studio_progress(pct, message)` whenever it changes phase.
3. Needs a user decision → `studio_ask(questions[])` (the tool blocks until answered). Never guess.
4. Spends money outside → `studio_cost_request(service, units, estimate, detail)` before doing it.
5. Finish with a StepResult:

```json
{
  "status": "done | needs_input | failed",
  "summary": "1–3 sentences in Vietnamese",
  "artifacts": [{"path": "review/preview.mp4", "kind": "video", "label": "Nháp 960×540"}],
  "questions": [],
  "notes_for_next_step": "…"
}
```

### 6.3 "studio" MCP server (provided by the app, runs in the app's process)

| Tool | Effect |
|---|---|
| `studio_progress` | Updates the progress bar + status line |
| `studio_ask` | Creates a question Approval and **waits** for the answer (configurable timeout; on timeout → returns "the user has not answered", Claude ends with `needs_input`) |
| `studio_cost_request` | Creates a cost Approval, waits for Yes/No |
| `studio_artifact` | Registers an output mid-run (so the user can see drafts early) |
| `permission` | Called by `--permission-prompt-tool` when Claude uses a tool not yet allowed → matched against the preset's `permissions` rules: allow / deny / ask the user |

Sample permission rules (preset):
```yaml
permissions:
  allow: ["Bash(python3 *)", "Bash(ffmpeg *)", "Bash(node *)", "Edit", "Write"]
  ask:   ["Bash(*elevenlabs*)", "Bash(rm *)", "Bash(cp * videos/*)", "mcp__*__upload*"]
  deny:  ["Bash(git push*)", "Bash(sudo *)"]
```

### 6.4 Checks
The app runs them itself after Claude finishes; **Claude never grades its own work**:
```yaml
checks:
  - name: QA export
    run: python3 {skill}/scripts/qa_export.py exports/{slug}.mp4
  - name: Camera không gây chóng mặt
    run: python3 tmp/cammotion.py review/preview.mp4
```
Exit 0 = PASS. Logs are kept per run.

The app's built-in checks (`studio-check <name>`), usable in any preset:

| Command | Checks |
|---|---|
| `studio-check outputs` | Every glob in the step's `outputs` matches ≥1 file, files are non-empty and newer than the run start |
| `studio-check deliver-cmp` | Every file in the delivery folder is byte-identical (`cmp`) to the original in `exports/` |
| `studio-check loudness --target -14 --tp -1.5` | Measured with ffmpeg `ebur128`, within ≤ 1 LU and true peak ≤ threshold |
| `studio-check no-credit-section exports/publish.md` | The description has no "Ghi công"/"Credits" section |

A step using `auto_if_checks`/`auto_after` with **no checks at all** → the loader reports a preset error (prevents an auto gate
"passing" because nothing was checked).

### 6.5 Parallel terminal sessions
The user can still open `claude --resume <session>` in a terminal to work by hand; when the app sees the lock held by another pid
it switches the project to "working by hand" and only watches file changes. When done, the user clicks "Mark step done".

---

## 7. Data model (SQLite `~/.video-studio/studio.db`)

```sql
channels(id, name, platform, root_dir, rules_md, schedule_json, budget_json)
presets(id, channel_id, file_path, version_hash)
projects(id, channel_id, preset_id, slug, title, dir, claude_session_id, status, autopilot, created_at, updated_at)
steps(id, project_id, key, name, ord, state, gate_json, current_run_id, approved_run_id, updated_at)
runs(id, step_id, n, state, prompt, feedback, started_at, ended_at, session_id, result_json, exit_code)
run_events(id, run_id, ts, type, payload_json)          -- stream-json + progress, trimmed when large
artifacts(id, run_id, path, kind, label, sha256, bytes, meta_json)
checks(id, run_id, name, cmd, passed, log_path, duration_ms)
approvals(id, project_id, step_id, run_id, kind, payload_json, state, created_at, decided_at, decision_json, auto_at)
rules(id, channel_id, grp, text, why, source_run_id, enabled, created_at)
costs(id, run_id, kind, units, unit_name, usd, note)    -- claude_tokens, elevenlabs_credits, render_minutes
ideas(id, channel_id, title, pitch, status, project_id, sort)
```

Inside each project:
```
<project>/.studio/
  project.json          # copy of the state (so the project describes itself if the DB is lost)
  lock                  # pid, host, since
  summary.md            # Claude's summary after each step
  runs/<step>/<n>/      # prompt.md, system.md, stream.jsonl, result.json, checks/*.log, feedback.md
```

Versioned outputs: files stay where the preset says (e.g. `review/preview.mp4`); when a new run overwrites them, the app copies the old
version to `.studio/runs/<step>/<n>/artifacts/` (hard-link when possible) for A/B comparison. Files above a threshold (e.g. 2 GB) keep only a hash.

---

## 8. Preset YAML (condensed schema)

```yaml
id: string                 # unique
name: string
channel: string            # channel id
format: long | short
project_dir: string        # template, e.g. ~/Videos/projects/{slug}
skills: [path]             # added to --add-dir + Claude is told to read SKILL.md
rules: path?               # initial style bible
permissions: {allow, ask, deny}
defaults: {gate: {mode: manual}, timeout: 2h}
vars: {key: value}         # used in prompts as {key}
steps:
  - id: string
    name: string
    needs: [step_id]?      # default: the previous step
    prompt: string         # template with {slug} {title} {vars.*} {feedback} {prev.summary}
    outputs: [glob]
    checks: [{name, run}]?
    gate: {mode, after?}?
    cost: {service, estimate, always_ask: true}?
    resources: [render]?
    foreach: string?       # e.g. "shorts" → duplicate the step per list returned by the previous step
    manual: bool?          # a step the user does by hand (e.g. clicking Schedule in YouTube Studio) — checklist only
```

Sample preset in the repo: `presets/tiktok-short.yaml`; personal presets go in `~/.video-studio/presets/`.

---

## 9. Architecture

```
┌──────────────── Browser (127.0.0.1:4317) ────────────┐
│ React + Vite: Overview, Inbox, Step, Channel, Preset │
└───────────────▲──────────────────────┬───────────────┘
        SSE/WS  │                REST  │
┌───────────────┴──────────────────────▼───────────────┐
│ Node (Fastify) — app server                          │
│  • Scheduler: picks ready steps, project lock, sem.  │
│  • Runner: spawns `claude -p … stream-json`, parses  │
│  • "studio" MCP (local HTTP) + permission tool       │
│  • Checker: runs checks                              │
│  • Watcher: chokidar watches project folders         │
│  • Media: serves files with HTTP 206 (video seeking) │
│  • Notifier: macOS notification / Telegram (V2)      │
│  • SQLite (better-sqlite3)                           │
└───────────────┬──────────────────────────────────────┘
                │ spawn, cwd = project folder
         ┌──────▼──────┐   ┌────────────────────────────┐
         │ claude CLI  │──▶│ preset/skill scripts       │
         │ (the user's │   │ python, ffmpeg, node, swift│
         │  sign-in)   │   └────────────────────────────┘
         └─────────────┘
```

- One install command: `npx video-studio` (or `brew`). Requirements: Node ≥ 20, `claude` on PATH, ffmpeg (declared by presets).
- Startup check: `claude --version`, a trial `claude -p "ping" --output-format json` to know whether the user is signed in —
  if not, explain how to run `claude` and `/login` in a terminal. The app does **not** start a sign-in flow itself.
- No Docker needed. All of the user's data lives in `~/.video-studio/`.

---

## 10. Notifications & remote approval (V2)
- macOS notification on a new Approval.
- Telegram bot (token created by the user) sends messages with Approve/Reject buttons for simple Approvals (allow tool, cost,
  multiple-choice question). Approving a step with video → sends a link; reachable from a phone when using Tailscale (optional,
  installed by the user) — the app still binds only localhost/tailnet, never the Internet.

---

## 11. Legal & safety

- **Claude sign-in:** Anthropic's terms do not allow third-party products to *offer* claude.ai sign-in or use
  Pro/Max plan quota on behalf of others. The design avoids this: everyone installs and signs in to their own Claude Code;
  the app is only a local driver calling the CLI on their machine, just like running a `claude -p` script in a terminal. The README must state
  clearly: "Bring your own Claude Code", and recommend an API key for high-volume automated use. Re-read the current terms
  before publishing as open source.
- Never store or read Claude's credential files. Send no data outside beyond what Claude/presets do themselves.
- The server binds `127.0.0.1`, session token in a cookie, CORS blocked.
- Presets are code (they run shell commands) → when importing someone else's preset, show every `checks` command + `permissions`
  and require confirmation.
- Asset license gate (V2): an `assets` ledger (path, source, license); a `license-gate` check blocks CC BY / ElevenLabs Free
  for projects with `publish: true` (the "no attribution" rule).

---

## 12. Roadmap

| Milestone | Content | Done when |
|---|---|---|
| **M0** | Spec + UI prototype (this document) | The user approves the screen flow |
| **M1** | Server + SQLite + `claude -p` runner + log stream + read-only Overview/Step; 1 preset (TikTok short) | One short runs end to end from the app, with a live log |
| **M2** | Gates + Inbox + studio MCP (`ask`, `progress`, `permission`, `cost_request`) + checks + player/A-B | Approve/reject with feedback → new run; the ElevenLabs tool is blocked pending approval |
| **M3** | Rules from feedback, long-form YouTube preset, import old projects, lock + render semaphore, costs | One real long-form episode made entirely through the app |
| **M4** | Publishing calendar, Idea bank, `videos/` delivery, macOS/Telegram notifications | A 2-week calendar with suggested slots |
| **M5** | Open source: README, `npx`, preset-writing docs, neutral sample presets (no personal paths), CI | Someone else installs and runs a sample preset within 10 minutes |
| Later | YouTube Analytics → topic suggestions; upload via the YouTube API (always asks); automatic Shorts from long videos |  |

---

## 13. Open questions
1. Open-source project name & license (MIT suggested).
2. One Claude session per project or one per step (suggested: shared + summary when long).
3. Is a "Claude proposes the next step" mode beyond presets (dynamic pipeline) needed — suggested after M3.
4. Sync the style bible both ways with existing SKILL.md files, or export one way only.
5. Horror-channel planning Google Sheet: import once into the Idea bank or sync regularly.
