# Video Studio

[English](README.md) | [Tiếng Việt](README.vi.md)

A local video workshop: it splits video production into steps, runs each step with
[Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude -p`), and lets you follow progress and approve results in your browser.

Everything stays on your machine. The app listens on `127.0.0.1` only.

## Requirements

| | macOS | Windows 10/11 |
|---|---|---|
| [Node.js](https://nodejs.org) 20+ | `brew install node`, or download the `.pkg` installer from [nodejs.org](https://nodejs.org) if you don't have Homebrew | `winget install OpenJS.NodeJS.LTS` |
| [Git](https://git-scm.com) | `xcode-select --install` | `winget install Git.Git` |
| [Claude Code](https://docs.claude.com/en/docs/claude-code) | `curl -fsSL https://claude.ai/install.sh \| bash` | `irm https://claude.ai/install.ps1 \| iex` |
| Claude account | **Claude Pro / Max** plan, or an **Anthropic API Key**. The free Claude plan can't run `claude -p`, which the app uses. | same |

On Windows, run every command in **PowerShell**, and open a new window after installing so the new commands are found.
You can sign in to Claude from inside the app.

Check everything is installed before you continue (each command should print a version):

```sh
node -v && git --version && claude --version
```

## Quick start

Same commands on macOS (Terminal) and Windows (PowerShell):

```sh
git clone https://github.com/CRCAT25/video-studio.git
cd video-studio
npm install
npm run build
npm start -- --open
```

The browser opens at `http://127.0.0.1:4317/`. The first time:

1. Create a password.
2. Enter the **6-digit setup code** that the terminal prints.

Keep the terminal open while you use the app. Press `Ctrl+C` to stop it.
Next time, open a terminal in the `video-studio` folder and run `npm start -- --open`.

### Optional: global `video-studio` command

To run `video-studio` from any folder, run `npm link` once inside the repo, then use `video-studio --open`.
Nothing else needs it. If `npm link` fails with `EACCES` (macOS), skip it or install Node with Homebrew and retry.
Below, `npm start -- <options>` and `video-studio <options>` mean the same thing.

## Add a YouTube channel

1. In the app, open **Channels** and click **Google setup**. Follow the steps (this is needed only once).
2. Click **+ Add channel** and sign in with the channel's Google account.

> On Windows the automatic Google Cloud install is not available yet. Use **Set up manually** in the setup page and paste your `client_secret.json`.
> Get it in 3 steps on [Google Cloud Console](https://console.cloud.google.com/):
>
> 1. **Create a project** (project picker → **New project**), then open **APIs & Services → Library** and enable **YouTube Data API v3** and **YouTube Analytics API**.
> 2. Open **Google Auth Platform** (OAuth consent screen), click **Get started**, fill in **App information** (any name, your email) and pick **External**. Then under **Audience** click **Publish app**, so access isn't revoked after 7 days.
> 3. Open **Clients → Create client**, set **Application type** to **Desktop app**, click **Create**, then **Download JSON**. In the app, click **Choose a file…** (or paste the content) and **Save**.

## Workflows

A workflow is the list of steps Claude runs for one video (script, scenes, images, voice, subtitles, edit, publish pack…).

1. Click **+ New project** and pick a format: vertical (9:16, 4:5), horizontal (16:9 with optional 4K, 21:9) or square (1:1),
   then a short video (15–60 s) or a long video (3–30 min). The app suggests a full workflow for it.
2. Click **Continue** to customize: turn steps on or off, reorder them, rename them, choose how each step is approved,
   edit what Claude is told, or add a step. Steps that cost money always ask you first.
3. Tick **Save as my workflow** to reuse it next time, or save one from the **Workflows** page.

Saved workflows are YAML files in `presets/` inside the data folder; you can also edit them by hand.
Each project keeps its own copy, so editing or deleting a workflow never changes projects you already created.

## Skills

The **Skills** tab (next to Channels) is the app's own skill library, kept in `~/.video-studio/skills/<name>/SKILL.md` — it never touches `~/.claude/skills`.

- **Import** from `~/.claude/skills` on your machine, by pasting or uploading a `SKILL.md`, or from a public GitHub repo/folder (`https://github.com/owner/repo/tree/branch/folder`; needs `git`).
- **View and edit** `SKILL.md`, or delete a skill (you are warned if a workflow uses it).
- **Attach** skills when you create or edit a workflow — only the selected skills are loaded for that workflow's steps.
- **Per-channel table**: the Skills page is a table — tick a channel's box to use a skill there, or **All channels** to share it (channels added later get it too). A video for channel X loads only the skills ticked for X plus shared ones, even if a workflow lists others. Newly imported skills are shared by default.
- **AI search** lives in its own "Find skills" tab (the "Library" tab is never filtered). Results show an AI-estimated fit percentage for each channel; tick a box to apply a skill to that channel. Describe what you need (e.g. "make stick-figure videos"). **Quick search** asks Claude once; **Discuss** lets Claude ask up to 3 short questions first, then searches with the refined need. Claude searches your library and `~/.claude/skills`; **Search the web too** also suggests public GitHub skills. Suggestions are never imported automatically. When nothing fits, an "AI suggestions" box offers alternative keywords, a web search, and "Create new skill" (opens the paste dialog prefilled).

Skills are instructions Claude follows, so import only ones you trust.

## Reference video

Instead of loading skills, a new project can borrow the approach of one of your own published videos: in **New project**, pick a channel connected to YouTube, filter by title, sort by views or newest, and choose a video. Its title, description, length, views, likes and average watch time are written to `<project>/.studio/reference.md`, and every step is told to read it for structure and pacing only (no script or visuals are available, and the text is treated as data, not instructions). Optional; one video per project.

Required fields are marked with a red `*`. "Use another folder" opens the system folder dialog (macOS) instead of accepting a typed path.

## AI assistant

Click **AI assistant** in the header to open a sidebar and ask Claude to work the page for you,
e.g. "set the video length to 60". It reads the open page, clicks and types like you would, and shows each action in the chat.

- It runs `claude` with the account you are signed in to, so it uses your plan's usage just like Claude Code in a terminal.
  By default it uses your account's default model; pick **Opus / Sonnet / Haiku** and an **effort** level under the input box (saved per chat).
- Before deleting, stopping, running or other risky clicks it asks you first (**Allow** / **No**).
  Buttons that spend money or touch secrets are blocked; you click those yourself.
- Chats are kept across reloads (last 30). The clock icon opens the history to reopen or delete a chat; **New chat** starts a fresh one and keeps the old one;
  **Stop** stops the current answer. The **⋯** menu has **Compact conversation**, which shrinks the conversation context (`/compact`) so a long chat can go on.

## Plan usage

The header shows how much of your Claude plan's **5-hour limit** is used (e.g. `5h 42%`). It turns yellow at 80% and red when you hit the limit.
Click it to see the 5-hour and weekly bars with their reset times, and how many tokens this app used today and in the last 7 days
(video steps, AI assistant, checks).

- The numbers update after every Claude turn the app runs, and when you open the panel.
  **Check now** fetches fresh numbers the same way `/usage` does in Claude Code: no tokens used, every 10 s at most.
- To do that the app reads Claude Code's sign-in token (on macOS, allow the Keychain prompt with **Always Allow**).
  The token stays inside the app server and is sent only to `api.anthropic.com`.
  If it can't be read or the request fails, **Check now** asks Claude instead (a few thousand tokens, once a minute at most) and says so.
- The percentages cover your whole Claude account, including Claude Code in a terminal or the desktop app. Token counts cover only this app.
- It needs a Claude plan sign-in (Pro / Max); with an API key there are no plan limits to show.

## Language

The interface is available in Vietnamese (default) and English. Open the account menu in the header (the **Claude** button),
pick **Language**, and the choice is remembered in your browser. The same menu holds the light/dark theme, the Claude account and **Sign out**, which keeps the header compact on small screens.

Workflow step names, server error messages and the AI assistant's replies follow the chosen language. Prompts sent to Claude and names you type yourself stay as written.

## Update

The app shows a banner when a new release is out. Click **Update**, then **Restart**. That's it.

From the terminal instead:

```sh
npm start -- --update
```

Then press `Ctrl+C` and run `npm start` again.

## Run in the background (macOS only)

The app starts at login, restarts if it crashes, and uses port **4318**.

```sh
npm run service:install     # install and start
npm run open                # open in the browser
npm run service:status      # is it running?
npm run service:restart     # after an update
npm run service:uninstall   # remove it (your data is kept)
```

- Logs: `~/.video-studio/logs/server.log`
- Daily DB backups (7 kept): `~/.video-studio/backups`

On Windows, keep a PowerShell window running `npm start` instead.

## Where your data lives

| | macOS | Windows |
|---|---|---|
| Data folder (DB, settings, workflows) | `~/.video-studio` | `%USERPROFILE%\.video-studio` |
| Google tokens and secrets | Keychain | `secrets.json` in the data folder (not encrypted — keep this folder private) |

## Troubleshooting

| Problem | Fix |
|---|---|
| Forgot password | `npm start -- reset-password`, then open the app and use the new setup code |
| `video-studio: command not found` | The global command is optional: use `npm start` in the repo, or run `npm link` there |
| `npm link` fails with `EACCES` (macOS) | Skip it and use `npm start`, or install Node with Homebrew (`brew install node`) and retry |
| Windows: "running scripts is disabled on this system" | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| Port 4317 is busy | The app picks the next free port automatically; use the URL it prints, or `npm start -- --port 5000` |
| Service won't start (macOS) | Stop the app if it's already running in a terminal, then `npm run service:restart` |
| `claude` not found | macOS: `export VS_CLAUDE_BIN=/path/to/claude` · Windows: `$env:VS_CLAUDE_BIN = "C:\path\to\claude.exe"` |

## Configuration

Optional settings:

| Option | Default | Description |
|---|---|---|
| `--port <n>` / `VS_PORT` | `4317` | Port |
| `--open` | off | Open the browser at startup |
| `--model <name>` / `VS_MODEL` | — | Default model for steps |
| `VS_HOME` | `~/.video-studio` | Data folder (DB, settings, workflows) |
| `VS_CLAUDE_BIN` | `claude` on PATH | Path to Claude Code |
| `VS_UPDATE_CHECK=0` | on | Turn off the new-release check |

Set a variable for one run:

```sh
VS_PORT=5000 npm start              # macOS
$env:VS_PORT = 5000; npm start      # Windows PowerShell
```

Run `npm start -- --help` to see all options.

**Google sign-in (optional):** after Google setup, click **Turn on Google sign-in** to make your account the only one allowed.
The password keeps working.

## Development

```sh
npm test                 # unit tests
npm run e2e              # end-to-end tests in Chrome
npm run dev:server       # API server
npm run dev:web          # UI with hot reload (Vite)
```

Release (users see the update banner):

```sh
npm version minor
git push --follow-tags
gh release create vX.Y.Z --generate-notes
```

## License

[MIT](LICENSE) · [Privacy](PRIVACY.md) · [Design doc](docs/spec.md)
