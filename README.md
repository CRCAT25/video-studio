# Video Studio

A local video workshop: it splits video production into steps, runs each step with
[Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude -p`), and lets you follow progress and approve results in your browser.

Everything stays on your machine. The app listens on `127.0.0.1` only.

## Requirements

| | macOS | Windows 10/11 |
|---|---|---|
| [Node.js](https://nodejs.org) 20+ | `brew install node` | `winget install OpenJS.NodeJS.LTS` |
| [Git](https://git-scm.com) | `xcode-select --install` | `winget install Git.Git` |
| [Claude Code](https://docs.claude.com/en/docs/claude-code) | `curl -fsSL https://claude.ai/install.sh \| bash` | `irm https://claude.ai/install.ps1 \| iex` |

On Windows, run every command in **PowerShell**, and open a new window after installing so the new commands are found.
You can sign in to Claude from inside the app.

## Quick start

Same commands on macOS (Terminal) and Windows (PowerShell):

```sh
git clone https://github.com/CRCAT25/video-studio.git
cd video-studio
npm install
npm run build
npm link
video-studio --open
```

The first time you open the app:

1. Create a password.
2. Enter the **6-digit setup code** that the terminal prints.

Keep the terminal open while you use the app. Press `Ctrl+C` to stop it.
Next time, just run `video-studio` and open `http://127.0.0.1:4317/`.

> Without `npm link`, run `npm start` inside the repo folder instead of `video-studio`.

## Add a YouTube channel

1. In the app, open **Kênh** and click **Thiết lập Google**. Follow the steps (this is needed only once).
2. Click **+ Thêm kênh** and sign in with the channel's Google account.

> On Windows the automatic Google Cloud install is not available yet. Use **Tự làm thủ công** in the setup page and paste your `client_secret.json`.

## Workflows

A workflow is the list of steps Claude runs for one video (script, scenes, images, voice, subtitles, edit, publish pack…).

1. Click **+ Dự án mới** and pick a format: vertical (9:16, 4:5), horizontal (16:9 with optional 4K, 21:9) or square (1:1),
   then a short video (15–60 s) or a long video (3–30 min). The app suggests a full workflow for it.
2. Click **Tiếp tục** to customize: turn steps on or off, reorder them, rename them, choose how each step is approved,
   edit what Claude is told, or add a step. Steps that cost money always ask you first.
3. Tick **Lưu làm quy trình của tôi** to reuse it next time, or save one from the **Quy trình** page.

Saved workflows are YAML files in `presets/` inside the data folder; you can also edit them by hand.
Each project keeps its own copy, so editing or deleting a workflow never changes projects you already created.

## AI assistant

Click **Trợ lý AI** in the header to open a sidebar and ask Claude to work the page for you,
e.g. "set the video length to 60". It reads the open page, clicks and types like you would, and shows each action in the chat.

- It runs `claude` with the account you are signed in to, so it uses your plan's usage just like Claude Code in a terminal.
  By default it uses your account's default model; pick **Opus / Sonnet / Haiku** and an **effort** level under the input box (saved per chat).
- Before deleting, stopping, running or other risky clicks it asks you first (**Cho phép** / **Không**).
  Buttons that spend money or touch secrets are blocked; you click those yourself.
- Chats are kept across reloads (last 30). The clock icon opens the history to reopen or delete a chat; **Cuộc mới** starts a fresh one and keeps the old one;
  **Dừng** stops the current answer. The **⋯** menu has **compact**, which shrinks the conversation context (`/compact`) so a long chat can go on.

## Plan usage

The header shows how much of your Claude plan's **5-hour limit** is used (e.g. `5h 42%`). It turns yellow at 80% and red when you hit the limit.
Click it to see the 5-hour and weekly bars with their reset times, and how many tokens this app used today and in the last 7 days
(video steps, AI assistant, checks).

- The numbers update after every Claude turn the app runs, and when you open the panel.
  **Kiểm tra ngay** fetches fresh numbers the same way `/usage` does in Claude Code: no tokens used, every 10 s at most.
- To do that the app reads Claude Code's sign-in token (on macOS, allow the Keychain prompt with **Always Allow**).
  The token stays inside the app server and is sent only to `api.anthropic.com`.
  If it can't be read or the request fails, **Kiểm tra ngay** asks Claude instead (a few thousand tokens, once a minute at most) and says so.
- The percentages cover your whole Claude account, including Claude Code in a terminal or the desktop app. Token counts cover only this app.
- It needs a Claude plan sign-in (Pro / Max); with an API key there are no plan limits to show.

## Language

The interface is available in Vietnamese (default) and English. Open the account menu in the header (the **Claude** button),
pick **Language**, and the choice is remembered in your browser. The same menu holds the light/dark theme, the Claude account and **Đăng xuất**, which keeps the header compact on small screens.

Workflow step names, server error messages and the AI assistant's replies follow the chosen language. Prompts sent to Claude and names you type yourself stay as written.

## Update

The app shows a banner when a new release is out. Click **Cập nhật**, then **Khởi động lại**. That's it.

From the terminal instead:

```sh
video-studio --update
```

Then press `Ctrl+C` and run `video-studio` again.

## Run in the background (macOS only)

The app starts at login, restarts if it crashes, and uses port **4318**.

```sh
video-studio service install     # install and start
video-studio service open        # open in the browser
video-studio service status      # is it running?
video-studio service restart     # after an update
video-studio service uninstall   # remove it (your data is kept)
```

- Logs: `~/.video-studio/logs/server.log`
- Daily DB backups (7 kept): `~/.video-studio/backups`

On Windows, keep a PowerShell window running `video-studio` instead.

## Where your data lives

| | macOS | Windows |
|---|---|---|
| Data folder (DB, settings, workflows) | `~/.video-studio` | `%USERPROFILE%\.video-studio` |
| Google tokens and secrets | Keychain | `secrets.json` in the data folder (not encrypted — keep this folder private) |

## Troubleshooting

| Problem | Fix |
|---|---|
| Forgot password | `video-studio reset-password`, then open the app and use the new setup code |
| `video-studio: command not found` | Run `npm link` inside the repo, or use `npm start` |
| `npm link` fails with `EACCES` (macOS) | Install Node with Homebrew (`brew install node`), then run `npm link` again |
| Windows: "running scripts is disabled on this system" | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or run `video-studio.cmd` |
| Port 4317 is busy | The app picks the next free port automatically; use the URL it prints, or `video-studio --port 5000` |
| Service won't start (macOS) | Stop any `video-studio` already running in a terminal, then `video-studio service restart` |
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
VS_PORT=5000 video-studio              # macOS
$env:VS_PORT = 5000; video-studio      # Windows PowerShell
```

Run `video-studio --help` to see all options.

**Google sign-in (optional):** after Google setup, click **Bật đăng nhập Google** to make your account the only one allowed.
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
