# Privacy Policy — Video Studio

*Updated: 2026-10-26*

Video Studio is open-source software that runs on your own computer (it listens on `127.0.0.1` only).
The author runs **no server** and **does not receive, view or store** any of your data.

## Google data the app uses

When you add a YouTube channel, the app requests the following permissions, for the account you sign in with only:

| Scope | Used for |
|---|---|
| `youtube.readonly` | reading the channel name, subscriber count and video list |
| `yt-analytics.readonly` | reading views and watch time |
| `youtube.upload`, `youtube.force-ssl` | uploading videos to your channel — requested only if you enable uploads, used only when you click upload |
| `openid` (app sign-in, optional) | recognising you as the app owner; only a hash is stored, the app never reads your email or name |

## Where data is stored

- Google tokens are kept in your machine's secret store (Keychain on macOS). They never reach the browser or the logs.
- Channel names, channel IDs and cached statistics (refreshed every 6 hours) are stored in a SQLite file under `~/.video-studio` on your machine.
- To show your Claude plan usage, the app reads Claude Code's sign-in token (Keychain on macOS, `~/.claude/.credentials.json` elsewhere).
  It is kept in memory only, sent only to `api.anthropic.com` (the same request as `/usage` in Claude Code), and never reaches the browser, the logs or a file.
- The app shares this data with no one. Its only outbound connections go to Google's servers, for the purposes in the table above.

## Deleting data

- Click **Xóa kênh** (Remove channel) in the app: it revokes access at Google and deletes that channel's tokens and statistics.
- Or revoke access at any time at https://myaccount.google.com/permissions.
- Delete the `~/.video-studio` folder to remove all app data.

Video Studio's use and transfer of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

Contact: open an issue at https://github.com/CRCAT25/video-studio/issues.
