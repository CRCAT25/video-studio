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
| Data folder (DB, settings, presets) | `~/.video-studio` | `%USERPROFILE%\.video-studio` |
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
| `VS_HOME` | `~/.video-studio` | Data folder (DB, settings, presets) |
| `VS_CLAUDE_BIN` | `claude` on PATH | Path to Claude Code |
| `VS_UPDATE_CHECK=0` | on | Turn off the new-release check |

Set a variable for one run:

```sh
VS_PORT=5000 video-studio              # macOS
$env:VS_PORT = 5000; video-studio      # Windows PowerShell
```

Run `video-studio --help` to see all options.

**Your own presets:** put YAML files in `presets/` inside the data folder, using the same format as [`presets/`](presets).
A preset with the same `id` overrides the built-in one, so updates never touch your config.

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
