// Lớp gọi API của Video Studio: fetch cùng origin (cookie token), lỗi ném Error có {status, code, message}.

const DEFAULT_MSG = {
  network: 'Không kết nối được tới Video Studio. Kiểm tra server còn chạy không.',
  unauthorized: 'Phiên đăng nhập đã hết — tải lại trang để đăng nhập.',
  forbidden_origin: 'Yêu cầu bị chặn vì đến từ trang lạ.',
  forbidden_path: 'Đường dẫn nằm ngoài thư mục dự án.',
  bad_host: 'Địa chỉ truy cập không hợp lệ — hãy mở bằng 127.0.0.1 hoặc localhost.',
  not_found: 'Không tìm thấy.',
  preset_not_found: 'Không tìm thấy quy trình.',
  pipeline_not_found: 'Không tìm thấy quy trình.',
  invalid_pipeline: 'Quy trình chưa hợp lệ.',
  invalid_format: 'Định dạng video không hợp lệ.',
  invalid_name: 'Tên quy trình phải có 1–80 ký tự.',
  channel_not_found: 'Không tìm thấy kênh này.',
  busy: 'Dự án đang có bước chạy. Chờ xong hoặc dừng lượt đó trước.',
  locked: 'Thư mục dự án đang bị một tiến trình khác khóa.',
  not_runnable: 'Bước này chưa chạy được.',
  cost_confirm_required: 'Bước này tốn tiền thật — cần xác nhận chi phí trước khi chạy.',
  slug_taken: 'Slug đã có dự án khác dùng.',
  dir_taken: 'Thư mục đã thuộc một dự án khác.',
  invalid_title: 'Tiêu đề không hợp lệ.',
  invalid_slug: 'Slug không hợp lệ.',
  invalid_dir: 'Thư mục không hợp lệ.',
  invalid_body: 'Dữ liệu gửi lên không hợp lệ.',
  account_busy: 'Đang có lệnh đăng nhập / đăng xuất chạy — đợi xong hoặc bấm Hủy.',
  not_logging_in: 'Không có lượt đăng nhập nào đang chờ.',
  invalid_profile: 'Không tìm thấy hồ sơ Chrome này. Chọn lại hồ sơ.',
  runs_active: 'Đang có bước chạy — đợi xong hoặc bấm Dừng rồi mới đăng nhập / đăng xuất.',
  account_unavailable: 'Chức năng tài khoản Claude chưa bật trên server này.',
  youtube_unavailable: 'Chức năng YouTube chưa bật trên server này.',
  invalid_client_secret: 'File client_secret.json không hợp lệ — cần client loại "Ứng dụng máy tính".',
  yt_not_configured: 'Chưa thiết lập Google Cloud.',
  yt_not_connected: 'Kênh này chưa kết nối YouTube.',
  update_none: 'Đang là bản mới nhất.',
  yt_has_channels: 'Xóa mọi kênh trước khi xóa thiết lập Google.',
  yt_reauth: 'Google không còn chấp nhận quyền của app — bấm Kết nối lại.',
  yt_quota: 'Hết hạn mức YouTube API hôm nay — thử lại sau 14:00–15:00 giờ Việt Nam.',
  yt_api_disabled: 'API YouTube chưa bật trong dự án Google Cloud — xem Thiết lập Google, bước 2.',
  yt_bad_client: 'Google từ chối client — kiểm tra lại file client_secret.json.',
  yt_forbidden: 'Google từ chối truy cập kênh này.',
  yt_network: 'Không kết nối được tới Google.',
  yt_error: 'Google báo lỗi — thử lại sau.',
  gc_busy: 'Đang thiết lập — đợi bước hiện tại xong hoặc bấm Hủy.',
  gc_step: 'Bước này không còn khả dụng — tải lại trang.',
  gc_no_file: 'Không còn file nào để xử lý.',
  assistant_busy: 'Trợ lý đang làm — chờ xong hoặc bấm Dừng.',
  assistant_unavailable: 'Trợ lý AI chưa bật trên server này.',
  usage_cooldown: 'Vừa kiểm tra — thử lại sau ít phút.',
  usage_timeout: 'Claude không trả lời kịp — thử lại sau.',
  usage_unavailable: 'Chưa lấy được số liệu mức dùng.',
};

// Tạo Error mang status/code/message (+ data gốc từ server) để UI hiển thị.
export function apiError(status, code, message, data = null) {
  const err = new Error(message || DEFAULT_MSG[code] || `Lỗi máy chủ (${status}).`);
  err.status = status;
  err.code = code;
  err.data = data;
  return err;
}

async function request(method, url, body, { signal } = {}) {
  const init = { method, credentials: 'same-origin', cache: 'no-store', signal, headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw apiError(0, 'network', DEFAULT_MSG.network);
  }
  let data = null;
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const code = (data && typeof data.error === 'string' && data.error) || `http_${res.status}`;
    const message = (data && typeof data.message === 'string' && data.message) || DEFAULT_MSG[code] || `Lỗi máy chủ (${res.status}).`;
    throw apiError(res.status, code, message, data);
  }
  return data;
}

const enc = encodeURIComponent;
// {a: '1', b: null} → "?a=1" (bỏ giá trị rỗng).
const qs = (o) => {
  const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== ''));
  return p.size ? `?${p}` : '';
};
const stepPath = (id, key) => `/api/projects/${enc(id)}/steps/${enc(key)}`;

// Các hàm gọi endpoint theo hợp đồng §9.2.
export const api = {
  health: () => request('GET', '/api/health'),
  update: () => request('GET', '/api/update'),
  updateStart: () => request('POST', '/api/update', {}),
  updateRestart: () => request('POST', '/api/update/restart', {}),
  doctor: (refresh = false) => request('GET', `/api/doctor${refresh ? '?refresh=1' : ''}`),
  channels: () => request('GET', '/api/channels'),
  presets: () => request('GET', '/api/presets'),
  pipelineCatalog: () => request('GET', '/api/pipeline/catalog'),
  suggestPipeline: (f, opts) => {
    const q = new URLSearchParams();
    for (const k of ['orientation', 'aspect', 'length', 'duration']) if (f?.[k] != null && f[k] !== '') q.set(k, String(f[k]));
    if (f?.hd4k) q.set('hd4k', '1');
    return request('GET', `/api/pipeline/suggest?${q}`, undefined, opts);
  },
  savePipeline: (pipeline, name) => request('POST', '/api/pipelines', { pipeline, name }),
  deletePipeline: (id) => request('DELETE', `/api/pipelines/${enc(id)}`, {}), // thân {} để có Content-Type JSON (chặn CSRF)
  projects: (opts) => request('GET', '/api/projects', undefined, opts),
  createProject: (body) => request('POST', '/api/projects', body),
  project: (id, opts) => request('GET', `/api/projects/${enc(id)}`, undefined, opts),
  step: (id, key, opts) => request('GET', stepPath(id, key), undefined, opts),
  runStep: (id, key, { feedback, allowPaid } = {}) => {
    const body = {};
    if (feedback) body.feedback = feedback;
    if (allowPaid) body.allowPaid = true;
    return request('POST', `${stepPath(id, key)}/run`, body);
  },
  stopRun: (runId) => request('POST', `/api/runs/${enc(runId)}/stop`, {}),
  completeStep: (id, key) => request('POST', `${stepPath(id, key)}/complete`, {}),
  account: () => request('GET', '/api/claude/account'),
  chromeProfiles: () => request('GET', '/api/chrome-profiles'),
  claudeLogin: ({ method, profileDir } = {}) => request('POST', '/api/claude/login', { method, profileDir: profileDir ?? null }),
  claudeLoginCancel: () => request('POST', '/api/claude/login/cancel', {}),
  claudeLogout: () => request('POST', '/api/claude/logout', {}),
  claudeUsage: () => request('GET', '/api/claude/usage'),
  claudeUsageCheck: (body = {}) => request('POST', '/api/claude/usage/check', body),
  auth: () => request('GET', '/api/auth'),
  authEnable: () => request('POST', '/api/auth/google/enable', {}),
  authDisable: () => request('POST', '/api/auth/google/disable', {}),
  logout: () => request('POST', '/api/auth/logout', {}),
  youtube: () => request('GET', '/api/youtube'),
  ytSetup: (clientSecret) => request('POST', '/api/youtube/setup', { clientSecret }),
  ytSetupClear: () => request('POST', '/api/youtube/setup/clear', {}),
  gw: () => request('GET', '/api/youtube/wizard'),
  gwStart: (profileDir) => request('POST', '/api/youtube/wizard/start', { profileDir: profileDir ?? null }),
  gwProject: (projectId) => request('POST', '/api/youtube/wizard/project', { projectId }),
  gwOpen: (page) => request('POST', '/api/youtube/wizard/open', { page }),
  gwDownload: (keep) => request('POST', '/api/youtube/wizard/download', { keep: !!keep }),
  gwNext: () => request('POST', '/api/youtube/wizard/next', {}),
  gwBack: () => request('POST', '/api/youtube/wizard/back', {}),
  gwCancel: () => request('POST', '/api/youtube/wizard/cancel', {}),
  gwReset: () => request('POST', '/api/youtube/wizard/reset', {}),
  ytAdd: ({ profileDir } = {}) => request('POST', '/api/youtube/channels/add', { profileDir: profileDir ?? null }),
  ytAddCancel: () => request('POST', '/api/youtube/channels/add/cancel', {}),
  ytConnect: (id, { profileDir } = {}) => request('POST', `/api/youtube/channels/${enc(id)}/connect`, { profileDir: profileDir ?? null }),
  ytConnectCancel: (id) => request('POST', `/api/youtube/channels/${enc(id)}/connect/cancel`, {}),
  ytDisconnect: (id) => request('POST', `/api/youtube/channels/${enc(id)}/disconnect`, {}),
  ytStats: (id, refresh = false, range) => request('GET', `/api/youtube/channels/${enc(id)}/stats${qs({ refresh: refresh ? '1' : null, range })}`),
  ytVideoStats: (id, refresh = false, range) => request('GET', `/api/youtube/channels/${enc(id)}/video-stats${qs({ refresh: refresh ? '1' : null, range })}`),
  ytVideos: (id, refresh = false) => request('GET', `/api/youtube/channels/${enc(id)}/videos${refresh ? '?refresh=1' : ''}`),
  assistant: () => request('GET', '/api/assistant'),
  assistantSend: (text, tabId) => request('POST', '/api/assistant/message', { text, tabId }),
  assistantStop: () => request('POST', '/api/assistant/stop', {}),
  assistantReset: () => request('POST', '/api/assistant/reset', {}),
  assistantResult: (id, body) => request('POST', `/api/assistant/tool/${enc(id)}/result`, body),
  runEvents: (runId, after = 0, limit = 1000, opts) =>
    request('GET', `/api/runs/${enc(runId)}/events?after=${Number(after) || 0}&limit=${limit}`, undefined, opts),
};

// URL file media của dự án (mã hóa từng đoạn đường dẫn); studio=true để xem file trong .studio/runs/.
export function mediaUrl(projectId, relPath, { studio = false } = {}) {
  const clean = String(relPath || '').replace(/^\/+/, '');
  const p = clean.split('/').map(enc).join('/');
  return `/media/${enc(projectId)}/${p}${studio ? '?studio=1' : ''}`;
}

// Tải nội dung chữ (md/json/txt) có giới hạn dung lượng; trả {text, truncated}.
export async function fetchText(url, { maxBytes = 262144, signal } = {}) {
  let res;
  try {
    res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal, headers: { range: `bytes=0-${maxBytes - 1}` } });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw apiError(0, 'network', DEFAULT_MSG.network);
  }
  if (!res.ok) {
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    const code = data?.error || `http_${res.status}`;
    const msg = data?.message || (res.status === 404 ? 'Không tìm thấy file.' : DEFAULT_MSG[code] || `Không tải được file (${res.status}).`);
    throw apiError(res.status, code, msg, data);
  }
  const buf = await res.arrayBuffer();
  let truncated = false;
  let bytes = new Uint8Array(buf);
  if (res.status === 206) {
    const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
    if (m && Number(m[1]) > bytes.length) truncated = true;
  }
  if (bytes.length > maxBytes) {
    bytes = bytes.subarray(0, maxBytes);
    truncated = true;
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return { text, truncated };
}
