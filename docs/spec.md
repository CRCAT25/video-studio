# Video Studio — Tài liệu thiết kế (v0.1, 25/10/2026)

> Tên tạm. Một app **chạy local**, **opensource**, giữ pipeline làm video theo từng bước và giao từng bước cho
> **Claude Code đã đăng nhập sẵn trên máy người dùng**. Người dùng nhìn thấy đang ở bước nào, Claude đang làm gì,
> và quyết định bước nào phải duyệt tay, bước nào cho tự duyệt.

---

## 1. Vấn đề cần giải quyết

Rút ra từ ~3 tuần làm 3 kênh (2 kênh YouTube + TikTok) bằng Claude Code trong terminal:

| Đau | Ví dụ thực tế |
|---|---|
| Không nhìn được tổng thể: tập nào đang ở bước nào | Phải đọc memory / `ls exports/` mới biết Tập 02 đã render final chưa |
| Nhiều phiên song song làm trùng việc | 08/10 suýt tốn ~612 credit ElevenLabs cho video đã xong ở phiên khác |
| Mỗi dự án tự viết trang review riêng | `review_server.py` :8765, :8766, :8767… mỗi dự án một bản |
| Cổng duyệt chỉ nằm trong lời dặn | "review localhost trước khi render", "hỏi trước khi tốn credit" — Claude phải nhớ |
| Góp ý của người dùng thành quy tắc rải rác | memory feedback + SKILL.md + Google Sheet "Style" |
| Không biết đã tốn bao nhiêu | credit ElevenLabs, giờ render, token Claude |
| Lịch đăng & giao hàng làm tay | 2 ngày 1 video 11:30, copy `videos/<Tiêu đề>/` + `cmp` |

**Mục tiêu:** một màn hình duy nhất cho toàn bộ dây chuyền; cổng duyệt và chi phí là **luật của hệ thống**,
không phải lời dặn trong prompt; mọi pipeline mô tả bằng **preset** để người khác dùng lại được.

**Không phải mục tiêu (V1):** không tự render video (Claude + script của preset làm), không lưu trữ cloud,
không phục vụ nhiều người dùng trên một server, không tự upload YouTube.

---

## 2. Nguyên tắc thiết kế

1. **Bring your own Claude.** App không bao giờ hỏi/lưu thông tin đăng nhập claude.ai. Nó gọi `claude` CLI mà người
   dùng đã tự `claude /login` (gói Pro/Max) hoặc đã đặt `ANTHROPIC_API_KEY`. Xem mục 11.
2. **Đĩa là nguồn sự thật.** File dự án nằm nguyên chỗ cũ (`~/Documents/Youtube/ai-video-projects/<slug>`); app chỉ
   thêm thư mục `.studio/` trong dự án. Xóa app thì dự án vẫn dùng được với Claude trong terminal.
3. **Mỗi bước = một lượt Claude có hợp đồng rõ:** đầu vào, đầu ra, kiểm tra, cổng duyệt.
4. **Tiền luôn hỏi.** Bước/tool tốn tiền ngoài (ElevenLabs, generate ảnh/video, upload) không bao giờ tự duyệt,
   kể cả ở chế độ tự động hoàn toàn — trừ khi người dùng đặt ngân sách tự duyệt có trần.
5. **Nhanh có bản chạy được.** Nháp low-res có tiếng trước, chỉnh sau (bài học "test short speed first").
6. **Chỉ localhost.** Server bind `127.0.0.1`, token ngẫu nhiên trong URL lần đầu mở.

---

## 3. Khái niệm

| Khái niệm | Nghĩa |
|---|---|
| **Kênh (Channel)** | Một kênh đăng (YouTube/TikTok), có thư mục gốc, style bible, lịch đăng |
| **Preset** | File YAML mô tả pipeline: các bước, prompt, cổng duyệt, kiểm tra, chi phí. Một kênh có thể có nhiều preset (video dài, Short) |
| **Dự án (Project)** | Một video cụ thể, tạo từ preset, có slug + thư mục |
| **Bước (Step)** | Một mắt xích trong pipeline của dự án (Kịch bản, Giọng, Nháp, Review, Final, Giao hàng…) |
| **Lượt chạy (Run)** | Một lần Claude thực hiện bước. Bị từ chối → lượt mới kèm góp ý. Mọi lượt đều được giữ |
| **Đầu ra (Artifact)** | File bước tạo ra: video, audio từng câu, ảnh, markdown, json. Có phiên bản theo lượt |
| **Cổng (Gate)** | Điều kiện để bước được coi là xong: tay / tự duyệt nếu kiểm tra đạt / tự duyệt sau X phút / tự động |
| **Yêu cầu duyệt (Approval)** | Một việc đang chờ người dùng: duyệt bước, trả lời câu hỏi, cho phép tool, duyệt chi phí |
| **Quy tắc (Rule)** | Một dòng trong style bible của kênh, thường sinh ra từ góp ý khi từ chối |
| **Chi phí (CostEntry)** | Token Claude, credit dịch vụ ngoài, phút render — gắn với lượt chạy |

---

## 4. Các màn hình

### 4.1 Tổng quan (Overview)
- Thanh trên: số việc **đang chờ bạn**, số runner đang chạy, chi phí tháng này, nút **Dự án mới**.
- Lọc theo kênh. Mỗi dự án một hàng: tên, kênh, preset, **dải bước** (mỗi bước một ô màu theo trạng thái), bước
  hiện tại + mô tả 1 dòng ("Đang render chunk 3/4 — còn ~6 phút"), chi phí, cập nhật lần cuối.
- Bấm vào ô bước → Chi tiết bước.
- Cột phải (desktop) / tab (điện thoại): **Hộp duyệt** rút gọn.

### 4.2 Hộp duyệt (Inbox)
Gom mọi Approval đang mở, sắp theo độ khẩn:
1. **Cho phép tool** (Claude đang đứng chờ — ví dụ "Generate ElevenLabs 18 câu, ~1.230 credit").
2. **Câu hỏi của Claude** (form trả lời: chọn đáp án / gõ tự do).
3. **Duyệt bước** (xem nhanh đầu ra, Duyệt / Từ chối + góp ý).
4. **Duyệt chi phí trước bước** (bước có `cost.always_ask`).

Mỗi mục: dự án, bước, đã chờ bao lâu, hạn tự duyệt (nếu cổng `auto_after`).

### 4.3 Chi tiết bước
- **Đầu trang:** tên bước, trạng thái, lượt N, thời gian chạy, chi phí lượt này, nút Chạy lại / Dừng / Bỏ qua.
- **Tab Đầu ra:** player video (tua được, ghi chú theo mốc thời gian → góp ý tự kèm timecode + still), danh sách câu
  thoại có nút nghe từng câu, lưới ảnh tĩnh, xem markdown/json. **So sánh A/B** giữa 2 lượt (video cạnh nhau, audio
  bản 1/bản 2).
- **Tab Nhật ký:** stream thời gian thực từ Claude (`stream-json`): suy nghĩ ngắn, tool gọi (Bash/Edit/Write), file đổi,
  tiến độ do Claude báo qua `studio_progress`.
- **Tab Kiểm tra:** kết quả các lệnh check (`qa_export.py`, `cammotion.py`, `validate_project.py`…): PASS/FAIL + log.
- **Tab Cổng duyệt:** đổi chế độ cổng cho bước này (ghi đè preset cho riêng dự án).
- **Khung góp ý:** Duyệt / Từ chối. Khi từ chối: ô lý do + mốc thời gian → hỏi **"Lưu thành quy tắc của kênh?"**
  (xem 4.5). Góp ý trở thành prompt cho lượt chạy kế tiếp, cùng session Claude (`--resume`).

### 4.4 Dự án mới
Chọn kênh → preset → nhập ý tưởng / chọn từ **Kho ý tưởng** → slug + tiêu đề tạm → xem trước các bước và cổng →
Tạo. App tạo thư mục (hoặc gắn vào thư mục có sẵn — **nhập dự án cũ**), ghi `.studio/project.json`.

### 4.5 Kênh & Quy tắc
- Thông tin kênh, thư mục gốc, skill đi kèm, lịch đăng.
- **Style bible**: danh sách quy tắc (nhóm, nội dung, lý do, nguồn: "từ góp ý Tập 02 lượt 8"). Bật/tắt từng quy tắc.
  Quy tắc đang bật được ghép vào system prompt của mọi lượt chạy của kênh.
- Xuất/nhập `rules.md` để đồng bộ với SKILL.md hiện có.

### 4.5b Kênh YouTube (kết nối thật)
Tab **Kênh** (`#/channels`) ban đầu trống. Người dùng bấm **+ Thêm kênh**, đăng nhập Google của kênh đó và chọn kênh trên màn hình Google; app đọc tên kênh rồi lưu vào bảng `yt_channels`. Kênh YouTube không khai trong `channels.yaml` (file này chỉ còn kênh khác, vd. TikTok). Mã kênh nội bộ = tên kênh bỏ dấu (`bep-nha-minh`), trùng thì thêm `-2`. Thêm lại kênh đã có → 409 `yt_dup`.

- **Thiết lập Google** (`#/channels/setup`), làm 1 lần: người dùng tự tạo dự án Google Cloud, bật YouTube Data API v3 + YouTube Analytics API, đặt màn hình xin quyền là *Bên ngoài* và **Đang sản xuất** (để chế độ Thử nghiệm thì token hết hạn sau 7 ngày), điền trang chủ + chính sách quyền riêng tư (Google bắt buộc mới cho Xuất bản; app đưa sẵn link GitHub và `PRIVACY.md` của repo, kèm miền được phép `github.com`), tạo client **Desktop app**, rồi dán `client_secret.json` vào app. Client loại web bị từ chối.
- **Thêm / kết nối lại**: mỗi kênh một lần OAuth (kết nối lại chỉ khi Google bắt đăng nhập lại, phải chọn đúng kênh cũ, sai → 409 `yt_wrong_channel`), mở trong hồ sơ Chrome đã chọn (hoặc trình duyệt mặc định). Dùng loopback `http://127.0.0.1:<port>/api/youtube/oauth/callback` + PKCE S256 + `state` dùng một lần; route callback là public (hồ sơ Chrome khác có thể không có cookie của app). Scope đọc: `youtube.readonly`, `yt-analytics.readonly`; thêm `youtube.upload` + `youtube.force-ssl` khi bật tải lên. Không xin scope email/profile.
- **Bí mật**: client secret và refresh token chỉ ở server: Keychain trên macOS (`security -i`, giá trị hex qua stdin), file quyền 600 ở nơi khác. Không bao giờ gửi xuống trình duyệt hay ghi log. **Xóa kênh** = thu hồi ở Google + xóa token, dòng DB và cache.
- **Số liệu**: người đăng ký, tổng lượt xem; 28 ngày gần nhất (lượt xem, phút xem, đăng ký ròng, biểu đồ theo ngày); bảng video sắp xếp được. Cache SQLite 6 giờ, nút **Làm mới** để gọi lại Google. Analytics thường trễ 1–2 ngày.
- **Hạn mức**: ~10.000 điểm/ngày theo ngày giờ Los Angeles (đặt lại khoảng 14:00–15:00 giờ Việt Nam); app đếm và hiện số đã dùng. Tải 1 video lên ≈ 1.600 điểm.
- **Giới hạn của Google**: app chưa được xác minh → cảnh báo "chưa xác minh" (Nâng cao → Đi tới…); video tải lên từ dự án chưa được duyệt luôn ở chế độ Riêng tư; đặt hình thu nhỏ cần kênh đã xác minh số điện thoại.
- **SSE `youtube`**: phát mỗi khi trạng thái đổi, kể cả sau mỗi lần lấy số liệu → UI chỉ tải lại *trạng thái*, không tải lại số liệu (tránh vòng lặp).
- **Test**: `VS_SECRETS=file` (không đụng Keychain thật) và `VS_GOOGLE_BASE=<server giả>` (`test/fixtures/fake-google.mjs`).
- **Đợt 2 (chưa làm)**: chọn thư mục video đã giao cho từng kênh trong app, tải video lên từ đó (đọc `publish.md`), luôn Riêng tư, `madeForKids=false`, upload resumable có tiến độ, rồi hình thu nhỏ / phụ đề / danh sách phát.

### 4.6 Preset
Xem/sửa YAML, xem sơ đồ các bước, kiểm tra hợp lệ (schema), nhân bản preset.

### 4.7 Lịch & Kho ý tưởng (V2)
- Lịch tháng: slot theo luật kênh (vd: video dài cách 2 ngày; ngày xen giữa 2 Short).
  Dự án kéo vào slot; cảnh báo slot trống trong 7 ngày tới mà chưa có dự án ở bước Final.
- Kho ý tưởng: 💡 Ý tưởng → ✍️ Đang viết → ✅ Kịch bản xong → 🎬 Đang dựng → 📺 Đã đăng. Nhập từ Google Sheet/markdown.

### 4.8 Chi phí
Theo tháng / kênh / dự án / loại: token Claude (subscription: chỉ hiện token & số lượt; API key: USD), credit
ElevenLabs, phút render. Trần ngân sách theo kênh/tháng.

---

## 5. Máy trạng thái của bước

```
pending ──(bước trước xong)──▶ ready ──(runner nhận)──▶ running
running ──studio_ask──────────▶ needs_input ──(trả lời)──▶ running
running ──tool nhạy cảm───────▶ needs_permission ──(cho/không)──▶ running
running ──xong, check chạy────▶ checking ──▶ awaiting_review (cổng tay)
                                         └─▶ approved (cổng tự, check đạt)
awaiting_review ──Duyệt──▶ approved
awaiting_review ──Từ chối + góp ý──▶ ready (lượt N+1)
running ──lỗi/hết giờ──▶ failed ──Chạy lại──▶ ready
* ──Bỏ qua──▶ skipped
approved ──(bước trước bị chạy lại & đầu ra đổi)──▶ stale  (báo người dùng, không tự chạy lại)
```

- Một dự án chỉ có **một runner** tại một thời điểm (khóa `.studio/lock` có pid + host). Phiên terminal khác muốn
  làm cùng dự án sẽ thấy khóa (thêm 1 hook `SessionStart` tùy chọn để Claude trong terminal cũng biết).
- Bước khác dự án chạy song song, nhưng tài nguyên nặng đi qua **semaphore**: `render` (mặc định 4 job trên máy 16 GB),
  `gpu`, `network-heavy`. Preset khai báo `resources: [render]`.

### Cổng duyệt (gate)

| Chế độ | Hành vi |
|---|---|
| `manual` | Luôn chờ người dùng |
| `auto_if_checks` | Tự duyệt nếu mọi `checks` PASS, ngược lại chờ người dùng |
| `auto_after` | Chờ người dùng tối đa `after` (vd 30m), hết giờ thì tự duyệt (chỉ khi check PASS) |
| `auto` | Tự duyệt ngay |

Ghi đè theo thứ tự: preset → kênh → dự án → "chế độ lái tự động" toàn cục (Tắt / Thận trọng / Mạnh tay —
nâng mọi `manual` không phải bước tiền lên `auto_if_checks`). **Bước có `cost` hoặc tool nằm trong
`always_ask` không bao giờ bị nâng.**

---

## 6. Tích hợp Claude Code

### 6.1 Một lượt chạy

```bash
claude -p "<prompt bước + góp ý>" \
  --output-format stream-json --verbose \
  --session-id <uuid>            # lượt đầu của dự án; các lượt sau: --resume <uuid>
  --append-system-prompt-file .studio/run/<run>/system.md \  # giao thức studio + quy tắc kênh
  --add-dir <thư mục skill> \
  --mcp-config .studio/run/<run>/mcp.json \                    # MCP server "studio" của app
  --permission-mode acceptEdits \
  --permission-prompt-tool mcp__studio__permission \
  --json-schema '<schema StepResult>'
```

- `cwd` = thư mục dự án. App đọc stream từng dòng JSON → lưu vào `runs.log` + đẩy SSE/WebSocket lên UI.
- Message `result` cuối cùng cho: `session_id`, `usage`, `total_cost_usd` (API key), `duration_ms`, và
  `structured_output` theo schema StepResult.
- **Một session Claude cho cả dự án** (resume giữa các bước) để Claude nhớ ngữ cảnh; khi session quá dài, app tạo
  session mới kèm bản tóm tắt `.studio/summary.md` (Claude tự viết ở cuối mỗi bước).
- Chế độ API key: thêm `--max-budget-usd` theo trần của bước.

### 6.2 Giao thức studio (system prompt ghép thêm)

Claude được dặn:
1. Chỉ làm đúng bước `{step.name}`; đầu ra phải nằm trong `{step.outputs}`.
2. Báo tiến độ bằng tool `studio_progress(pct, message)` mỗi khi đổi giai đoạn.
3. Cần người dùng quyết → `studio_ask(questions[])` (tool chặn tới khi có trả lời). Không đoán.
4. Tốn tiền ngoài → `studio_cost_request(service, units, estimate, detail)` trước khi làm.
5. Kết thúc bằng StepResult:

```json
{
  "status": "done | needs_input | failed",
  "summary": "1–3 câu tiếng Việt",
  "artifacts": [{"path": "review/preview.mp4", "kind": "video", "label": "Nháp 960×540"}],
  "questions": [],
  "notes_for_next_step": "…"
}
```

### 6.3 MCP server "studio" (do app cung cấp, chạy trong process của app)

| Tool | Tác dụng |
|---|---|
| `studio_progress` | Cập nhật thanh tiến độ + dòng trạng thái |
| `studio_ask` | Tạo Approval loại câu hỏi, **chờ** câu trả lời (timeout cấu hình; hết giờ → trả "người dùng chưa trả lời", Claude kết thúc với `needs_input`) |
| `studio_cost_request` | Tạo Approval chi phí, chờ Có/Không |
| `studio_artifact` | Đăng ký đầu ra giữa chừng (để người dùng xem nháp sớm) |
| `permission` | Được gọi bởi `--permission-prompt-tool` khi Claude dùng tool chưa được phép → khớp luật `permissions` của preset: cho luôn / từ chối / hỏi người dùng |

Luật quyền mẫu (preset):
```yaml
permissions:
  allow: ["Bash(python3 *)", "Bash(ffmpeg *)", "Bash(node *)", "Edit", "Write"]
  ask:   ["Bash(*elevenlabs*)", "Bash(rm *)", "Bash(cp * videos/*)", "mcp__*__upload*"]
  deny:  ["Bash(git push*)", "Bash(sudo *)"]
```

### 6.4 Kiểm tra (checks)
App tự chạy sau khi Claude xong, **không để Claude tự chấm**:
```yaml
checks:
  - name: QA export
    run: python3 {skill}/scripts/qa_export.py exports/{slug}.mp4
  - name: Camera không gây chóng mặt
    run: python3 tmp/cammotion.py review/preview.mp4
```
Exit 0 = PASS. Log lưu theo lượt.

Check dựng sẵn của app (`studio-check <tên>`), dùng được trong mọi preset:

| Lệnh | Kiểm |
|---|---|
| `studio-check outputs` | Mọi glob trong `outputs` của bước khớp ≥1 file, file không rỗng, mới hơn lúc bắt đầu lượt |
| `studio-check deliver-cmp` | Mỗi file trong thư mục giao trùng byte (`cmp`) với bản gốc trong `exports/` |
| `studio-check loudness --target -14 --tp -1.5` | Đo bằng ffmpeg `ebur128`, lệch ≤ 1 LU và true peak ≤ ngưỡng |
| `studio-check no-credit-section exports/publish.md` | Mô tả không có mục "Ghi công"/"Credits" |

Bước dùng `auto_if_checks`/`auto_after` mà **không có check nào** → loader báo lỗi preset (tránh cổng tự duyệt
"đạt" vì không kiểm gì).

### 6.5 Phiên terminal song song
Người dùng vẫn có thể mở `claude --resume <session>` trong terminal để làm tay; app thấy khóa bị chiếm bởi pid khác
thì chuyển dự án sang "đang làm tay", và chỉ theo dõi file thay đổi. Khi xong, người dùng bấm "Đánh dấu bước xong".

---

## 7. Mô hình dữ liệu (SQLite `~/.video-studio/studio.db`)

```sql
channels(id, name, platform, root_dir, rules_md, schedule_json, budget_json)
presets(id, channel_id, file_path, version_hash)
projects(id, channel_id, preset_id, slug, title, dir, claude_session_id, status, autopilot, created_at, updated_at)
steps(id, project_id, key, name, ord, state, gate_json, current_run_id, approved_run_id, updated_at)
runs(id, step_id, n, state, prompt, feedback, started_at, ended_at, session_id, result_json, exit_code)
run_events(id, run_id, ts, type, payload_json)          -- stream-json + progress, cắt bớt khi lớn
artifacts(id, run_id, path, kind, label, sha256, bytes, meta_json)
checks(id, run_id, name, cmd, passed, log_path, duration_ms)
approvals(id, project_id, step_id, run_id, kind, payload_json, state, created_at, decided_at, decision_json, auto_at)
rules(id, channel_id, grp, text, why, source_run_id, enabled, created_at)
costs(id, run_id, kind, units, unit_name, usd, note)    -- claude_tokens, elevenlabs_credits, render_minutes
ideas(id, channel_id, title, pitch, status, project_id, sort)
```

Trong mỗi dự án:
```
<dự án>/.studio/
  project.json          # bản sao trạng thái (để dự án tự mô tả được nếu mất DB)
  lock                  # pid, host, since
  summary.md            # Claude tóm tắt sau mỗi bước
  runs/<step>/<n>/      # prompt.md, system.md, stream.jsonl, result.json, checks/*.log, feedback.md
```

Đầu ra theo phiên bản: file vẫn ở chỗ preset quy định (vd `review/preview.mp4`); khi lượt mới ghi đè, app chép bản
cũ sang `.studio/runs/<step>/<n>/artifacts/` (hard-link nếu được) để so sánh A/B. File > ngưỡng (vd 2 GB) chỉ lưu hash.

---

## 8. Preset YAML (schema rút gọn)

```yaml
id: string                 # duy nhất
name: string
channel: string            # id kênh
format: long | short
project_dir: string        # mẫu, vd ~/Documents/Youtube/ai-video-projects/{slug}
skills: [path]             # thêm vào --add-dir + nhắc Claude đọc SKILL.md
rules: path?               # style bible khởi tạo
permissions: {allow, ask, deny}
defaults: {gate: {mode: manual}, timeout: 2h}
vars: {key: value}         # dùng trong prompt bằng {key}
steps:
  - id: string
    name: string
    needs: [step_id]?      # mặc định: bước liền trước
    prompt: string         # template, có {slug} {title} {vars.*} {feedback} {prev.summary}
    outputs: [glob]
    checks: [{name, run}]?
    gate: {mode, after?}?
    cost: {service, estimate, always_ask: true}?
    resources: [render]?
    foreach: string?       # vd "shorts" → nhân bản bước theo danh sách bước trước trả ra
    manual: bool?          # bước người dùng tự làm (vd bấm Lên lịch trên YouTube Studio) — chỉ có checklist
```

Preset mẫu trong repo: `presets/tiktok-short.yaml`; preset riêng đặt ở `~/.video-studio/presets/`.

---

## 9. Kiến trúc

```
┌──────────── Trình duyệt (127.0.0.1:4317) ────────────┐
│ React + Vite: Overview, Inbox, Step, Channel, Preset │
└───────────────▲──────────────────────┬───────────────┘
        SSE/WS  │                REST  │
┌───────────────┴──────────────────────▼───────────────┐
│ Node (Fastify) — app server                          │
│  • Scheduler: chọn bước ready, khóa dự án, semaphore │
│  • Runner: spawn `claude -p … stream-json`, parse     │
│  • MCP "studio" (HTTP local) + permission tool       │
│  • Checker: chạy checks                              │
│  • Watcher: chokidar theo dõi thư mục dự án          │
│  • Media: phục vụ file có HTTP 206 (tua video)       │
│  • Notifier: macOS notification / Telegram (V2)      │
│  • SQLite (better-sqlite3)                           │
└───────────────┬──────────────────────────────────────┘
                │ spawn, cwd = thư mục dự án
         ┌──────▼──────┐   ┌───────────────────────────┐
         │ claude CLI  │──▶│ script của preset/skill    │
         │ (login của  │   │ python, ffmpeg, node, swift│
         │ người dùng) │   └───────────────────────────┘
         └─────────────┘
```

- Một lệnh cài: `npx video-studio` (hoặc `brew`). Yêu cầu: Node ≥ 20, `claude` trong PATH, ffmpeg (preset tự khai).
- Khởi động kiểm tra: `claude --version`, chạy thử `claude -p "ping" --output-format json` để biết đã đăng nhập chưa —
  chưa thì hướng dẫn chạy `claude` và `/login` trong terminal. App **không** tự mở luồng đăng nhập.
- Không cần Docker. Mọi thứ của người dùng ở `~/.video-studio/`.

---

## 10. Thông báo & duyệt từ xa (V2)
- macOS notification khi có Approval mới.
- Telegram bot (token do người dùng tạo) gửi tin có nút Duyệt/Từ chối cho Approval đơn giản (cho phép tool, chi phí,
  câu hỏi trắc nghiệm). Duyệt bước có video → gửi link; mở được từ điện thoại khi dùng Tailscale (tùy chọn,
  người dùng tự cài) — app vẫn chỉ bind localhost/tailnet, không mở ra Internet.

---

## 11. Pháp lý & an toàn

- **Đăng nhập Claude:** điều khoản của Anthropic không cho sản phẩm bên thứ ba *cung cấp* đăng nhập claude.ai hoặc dùng
  quota gói Pro/Max thay người khác. Thiết kế tránh điều này: mỗi người tự cài & tự đăng nhập Claude Code của mình;
  app chỉ là trình điều khiển local gọi CLI trên máy họ, giống chạy script `claude -p` trong terminal. README phải ghi
  rõ: "Bring your own Claude Code" và khuyến khích API key cho dùng tự động khối lượng lớn. Cần đọc lại điều khoản
  hiện hành trước khi phát hành opensource.
- Không lưu, không đọc file credential của Claude. Không gửi dữ liệu ra ngoài ngoài những gì Claude/preset tự làm.
- Server bind `127.0.0.1`, token phiên trong cookie, chặn CORS.
- Preset là code (chạy lệnh shell) → khi nhập preset của người khác, hiển thị toàn bộ lệnh `checks` + `permissions`
  và yêu cầu xác nhận.
- Cổng giấy phép tài sản (V2): sổ `assets` (path, nguồn, license); check `license-gate` chặn CC BY / ElevenLabs Free
  cho dự án có `publish: true` (luật "không ghi công").

---

## 12. Lộ trình

| Mốc | Nội dung | Xong khi |
|---|---|---|
| **M0** | Spec + prototype UI (tài liệu này) | Người dùng duyệt luồng màn hình |
| **M1** | Server + SQLite + runner `claude -p` + stream log + Overview/Step đọc-only; 1 preset (TikTok short) | Chạy trọn 1 short từ app, xem log trực tiếp |
| **M2** | Gate + Inbox + MCP studio (`ask`, `progress`, `permission`, `cost_request`) + checks + player/A-B | Duyệt/từ chối có góp ý → lượt mới; tool ElevenLabs bị chặn chờ duyệt |
| **M3** | Quy tắc từ góp ý, preset kênh YouTube dài, nhập dự án cũ, khóa + semaphore render, chi phí | Làm 1 tập video dài thật hoàn toàn qua app |
| **M4** | Lịch đăng, Kho ý tưởng, giao hàng `videos/`, thông báo macOS/Telegram | Lịch 2 tuần tự đề xuất slot |
| **M5** | Opensource: README, `npx`, docs viết preset, preset mẫu trung tính (không đường dẫn cá nhân), CI | Người khác cài & chạy preset mẫu trong 10 phút |
| Sau | YouTube Analytics → gợi ý chủ đề; upload qua YouTube API (luôn hỏi); xuất Shorts tự động từ video dài |  |

---

## 13. Câu hỏi còn mở
1. Tên dự án opensource & license (đề xuất MIT).
2. Một session Claude cho cả dự án hay mỗi bước một session (đề xuất: chung + tóm tắt khi dài).
3. Có cần chế độ "Claude tự đề xuất bước tiếp theo" ngoài preset (pipeline động) không — đề xuất để sau M3.
4. Đồng bộ style bible hai chiều với SKILL.md hiện có hay chỉ xuất một chiều.
5. Google Sheet kế hoạch Truyện ma: nhập một lần vào Kho ý tưởng hay đồng bộ thường xuyên.
