# Video Studio

A video workshop that runs on your own machine: it splits video production into steps, hands each step to
Claude Code (`claude -p`), and lets you watch progress and approve results in the browser.

All data stays on your machine: each video's files live in its project folder, while the DB and settings live in `~/.video-studio`.
The app only listens on `127.0.0.1`, so other machines cannot reach it.

## Requirements

- Node.js 20 or newer (24 recommended)
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed. You can sign in to Claude from inside the app.
- macOS works best (background service, Keychain, opening the right Chrome profile). Linux/Windows run the core features.

## Install (once)

```sh
git clone https://github.com/CRCAT25/video-studio.git && cd video-studio
npm install
npm run build
npm link        # adds a `video-studio` command you can run from any folder
```

## Open the app

Open a terminal and run:

```sh
video-studio
```

The terminal prints `http://127.0.0.1:4317/`. Cmd+click it to open the app.
Keep the terminal window open while you use the app. Press Ctrl+C to stop it.

Options: `video-studio --open` opens the browser for you, `video-studio --port 4318` changes the port, `video-studio --help`
lists everything. Without `npm link`, run `npm start` inside the repo instead.

Updating: run `video-studio --update` (it runs `git pull`, reinstalls dependencies when needed and rebuilds the UI), then stop the running app and start `video-studio` again. If it runs as a background service, use `video-studio service restart`.

## Sign-in

- **Password** (default): the first time you open the app you create a password. To prove it is really you, that screen also
  asks for the **6-digit setup code** printed in the terminal. After that you only need the password; the browser stays signed in for 30 days.
- **Forgot your password:** run `video-studio reset-password` (without `npm link`: `npm start -- reset-password`), then open
  the app and create a new password with the setup code it prints.
- **Google** (optional): finish *Google setup* in the app, then click **Enable Google sign-in** to make yourself the owner.
  From then on the Google button on the sign-in page only accepts that account (the password still works). The app only requests `openid` and never reads your email.

## Presets and channels

The repo ships a sample preset `presets/tiktok-short.yaml` and a sample channel list `presets/channels.yaml` (non-YouTube channels).
YouTube channels are added in the app: **Channels** page → **+ Add channel** → sign in with the channel's Google account (do *Google setup* first).
Put your own presets in `~/.video-studio/presets/` (same format). A preset with the same `id` overrides the one in the repo, and
the `channels.yaml` there takes priority, so updating the code never touches your configuration.

## Background service (macOS)

The app starts when you log in and restarts itself if it stops, on fixed port 4318:

```sh
npm run service:install     # install + start
npm run open                # open the app (prints a setup code the first time)
npm run service:status      # check whether it is running
npm run service:restart     # after updating the code (run npm run build first)
npm run service:uninstall   # remove it, keeping your data
```

Logs go to `~/.video-studio/logs/server.log`. The DB is backed up daily to `~/.video-studio/backups`, keeping 7 copies.
Stop any `video-studio` running on the same port before installing.

## Environment variables

| Variable | Meaning |
|---|---|
| `VS_HOME` | data folder (default `~/.video-studio`) |
| `VS_PORT` | port (default 4317) |
| `VS_TOKEN` | hidden token for tests/dev (default `VS_HOME/token`) |
| `VS_CLAUDE_BIN` | path to `claude` if it is not on PATH |
| `VS_MODEL` | default model for steps |

## Development

```sh
npm test                    # unit tests
npm run e2e                 # drive the real app in Chrome (playwright-core)
npm run dev:server          # server, prints the Vite command
npm run dev:web             # UI (Vite)
```

License: [MIT](LICENSE). Privacy: [PRIVACY.md](PRIVACY.md). Design doc: [docs/spec.md](docs/spec.md), M1 contract: [docs/m1-contract.md](docs/m1-contract.md).
