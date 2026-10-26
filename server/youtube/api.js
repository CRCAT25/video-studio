// Đọc số liệu YouTube: Data API v3 (kênh, video) + Analytics API v2 (28 ngày, theo video). Đếm hạn mức Data API.
import { gfetch } from './http.js';

export const DAILY_QUOTA = 10_000;
export const MAX_VIDEOS = 200;
export const PERIOD_DAYS = 28;

// Ngày hiện tại theo giờ Thái Bình Dương (hạn mức YouTube reset lúc 0h PT) dạng YYYY-MM-DD.
export function quotaDay(at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

// Cộng/trừ ngày trên chuỗi YYYY-MM-DD.
export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "PT1H2M3S" → giây; sai → null.
export function parseDuration(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(s || ''));
  if (!m) return null;
  return (Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0);
}

const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// Bảng Analytics {columnHeaders, rows} → mảng object theo tên cột.
export function analyticsRows(rep) {
  const cols = (rep?.columnHeaders || []).map((h) => h.name);
  return (rep?.rows || []).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

// Bộ gọi API theo kênh. token(force) → access token; onUnits(n) được gọi cho mỗi lệnh Data API (tính hạn mức).
export function createYouTubeApi({ endpoints, fetch: fetchFn = globalThis.fetch, onUnits = () => {} }) {
  // GET có Bearer; 401 → làm mới token một lần rồi thử lại.
  async function get(token, base, pathname, params, units) {
    const url = `${base}/${pathname}?${new URLSearchParams(params)}`;
    if (units) onUnits(units);
    try {
      return await gfetch(fetchFn, url, { headers: { authorization: `Bearer ${await token(false)}` } });
    } catch (e) {
      if (e?.status !== 401) throw e;
      return gfetch(fetchFn, url, { headers: { authorization: `Bearer ${await token(true)}` } });
    }
  }
  const data = (token, p, params) => get(token, endpoints.data, p, params, 1);
  const analytics = (token, params) => get(token, endpoints.analytics, 'reports', { ids: 'channel==MINE', ...params }, 0);

  // Kênh của tài khoản vừa đăng nhập (mine=true) → thông tin công khai; không có kênh → null.
  async function myChannel(token) {
    const r = await data(token, 'channels', { part: 'snippet,statistics,contentDetails', mine: 'true' });
    const c = r?.items?.[0];
    if (!c) return null;
    return {
      id: c.id,
      title: c.snippet?.title ?? null,
      customUrl: c.snippet?.customUrl ?? null,
      publishedAt: c.snippet?.publishedAt ?? null,
      uploads: c.contentDetails?.relatedPlaylists?.uploads ?? null,
      subscribers: c.statistics?.hiddenSubscriberCount ? null : num(c.statistics?.subscriberCount),
      views: num(c.statistics?.viewCount),
      videos: num(c.statistics?.videoCount),
    };
  }

  // Tổng quan kênh + 28 ngày gần nhất (theo ngày) từ Analytics.
  async function channelStats(token, { today = quotaDay() } = {}) {
    const channel = await myChannel(token);
    const end = addDays(today, -1);
    const start = addDays(end, -(PERIOD_DAYS - 1));
    const rep = await analytics(token, {
      startDate: start,
      endDate: end,
      metrics: 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost',
      dimensions: 'day',
      sort: 'day',
    });
    const byDay = new Map(analyticsRows(rep).map((r) => [r.day, r]));
    const days = [];
    const totals = { views: 0, minutes: 0, subsGained: 0, subsLost: 0, avgViewDuration: null };
    let weighted = 0;
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const r = byDay.get(d) || {};
      const row = { date: d, views: num(r.views) ?? 0, minutes: num(r.estimatedMinutesWatched) ?? 0, subsGained: num(r.subscribersGained) ?? 0, subsLost: num(r.subscribersLost) ?? 0 };
      days.push(row);
      totals.views += row.views;
      totals.minutes += row.minutes;
      totals.subsGained += row.subsGained;
      totals.subsLost += row.subsLost;
      weighted += (num(r.averageViewDuration) ?? 0) * row.views;
    }
    if (totals.views > 0) totals.avgViewDuration = Math.round(weighted / totals.views);
    const { uploads, ...pub } = channel || {};
    return { channel: channel ? pub : null, period: { start, end, days: PERIOD_DAYS }, totals, days };
  }

  // Ảnh thu nhỏ cỡ vừa; chỉ nhận i.ytimg.com (CSP img-src chỉ mở host này).
  function thumbUrl(t) {
    const u = t?.medium?.url || t?.default?.url;
    return typeof u === 'string' && u.startsWith('https://i.ytimg.com/') ? u : null;
  }

  // Danh sách video (tối đa MAX_VIDEOS mới nhất) + số liệu Data API + Analytics trọn đời theo video.
  async function videos(token, { today = quotaDay() } = {}) {
    const channel = await myChannel(token);
    if (!channel?.uploads) return { videos: [], truncated: false };
    const ids = [];
    let pageToken;
    let truncated = false;
    do {
      const r = await data(token, 'playlistItems', { part: 'contentDetails', playlistId: channel.uploads, maxResults: '50', ...(pageToken ? { pageToken } : {}) });
      for (const it of r?.items || []) if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
      pageToken = r?.nextPageToken;
      if (pageToken && ids.length >= MAX_VIDEOS) truncated = true;
    } while (pageToken && ids.length < MAX_VIDEOS);
    const list = ids.slice(0, MAX_VIDEOS);
    const items = [];
    for (let i = 0; i < list.length; i += 50) {
      const r = await data(token, 'videos', { part: 'snippet,statistics,contentDetails,status', id: list.slice(i, i + 50).join(','), maxResults: '50' });
      items.push(...(r?.items || []));
    }
    let perVideo = new Map();
    if (items.length) {
      const startDate = channel.publishedAt ? channel.publishedAt.slice(0, 10) : '2005-02-14';
      const rep = await analytics(token, {
        startDate,
        endDate: today,
        metrics: 'views,averageViewDuration,subscribersGained,subscribersLost',
        dimensions: 'video',
        sort: '-views',
        maxResults: String(MAX_VIDEOS),
      });
      perVideo = new Map(analyticsRows(rep).map((r) => [r.video, r]));
    }
    const out = items.map((v) => {
      const a = perVideo.get(v.id) || {};
      return {
        id: v.id,
        title: v.snippet?.title ?? '',
        description: (v.snippet?.description || '').slice(0, 300),
        thumb: thumbUrl(v.snippet?.thumbnails),
        publishedAt: v.snippet?.publishedAt ?? null,
        duration: parseDuration(v.contentDetails?.duration),
        privacy: v.status?.privacyStatus ?? null,
        views: num(v.statistics?.viewCount),
        likes: num(v.statistics?.likeCount),
        comments: num(v.statistics?.commentCount),
        avgViewDuration: num(a.averageViewDuration),
        subsGained: num(a.subscribersGained),
        // Đăng ký ròng như Studio: mới − hủy.
        subs: a.subscribersGained == null ? null : num(a.subscribersGained) - (num(a.subscribersLost) ?? 0),
      };
    });
    out.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
    return { videos: out, truncated };
  }

  return { myChannel, channelStats, videos };
}
