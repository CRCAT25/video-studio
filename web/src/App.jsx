// Khung app: header + băng doctor + sidebar Trợ lý AI + định tuyến hash (Tổng quan / Chi tiết bước / Preset / Kênh), tải lại theo SSE 'change' / 'youtube'.
import { useCallback, useEffect, useRef, useState } from 'react';
import Header from './components/Header.jsx';
import DoctorBanner from './components/DoctorBanner.jsx';
import UpdateBanner from './components/UpdateBanner.jsx';
import ResetModal from './components/ResetModal.jsx';
import ClaudeAccount, { accountResultMessage } from './components/ClaudeAccount.jsx';
import { useUsage } from './components/Usage.jsx';
import { ToastProvider, useToast } from './components/Toast.jsx';
import AssistantPanel, { useAssistant } from './components/AssistantPanel.jsx';
import Overview from './pages/Overview.jsx';
import Step from './pages/Step.jsx';
import Pipelines from './pages/Pipelines.jsx';
import Channels, { ChannelDetail } from './pages/Channels.jsx';
import Skills from './pages/Skills.jsx';
import TTS from './pages/TTS.jsx';
import YouTubeSetup from './pages/YouTubeSetup.jsx';
import { api } from './api.js';
import { useHashRoute } from './lib/router.js';
import { applyTheme, storeTheme } from './lib/theme.js';
import { useSSE, useSSEStatus } from './hooks/useSSE.js';
import { useT } from './lib/i18n.jsx';

// Lỗi kết nối / xác thực đáng hiện lên băng đỏ (lỗi khác hiện tại chỗ).
function bannerError(e) {
  if (!e) return null;
  if (e.code === 'network' || e.code === 'unauthorized' || e.code === 'bad_host' || e.status >= 500) return e.message;
  return null;
}

// Ứng dụng gốc.
export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const route = useHashRoute();
  const sse = useSSEStatus();
  const [theme, setTheme] = useState(() => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'));
  const [doctor, setDoctor] = useState(null);
  const [doctorErr, setDoctorErr] = useState(null);
  const [overview, setOverview] = useState(null);
  const [overviewErr, setOverviewErr] = useState(null);
  const [presetsData, setPresetsData] = useState(null);
  const [presetsErr, setPresetsErr] = useState(null);
  const [channels, setChannels] = useState([]);
  const [account, setAccount] = useState(null);
  const [canLogout, setCanLogout] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [yt, setYt] = useState(null);
  const [ytErr, setYtErr] = useState(null);
  const ytTimer = useRef(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const lastAuthAt = useRef(undefined);
  const timer = useRef(null);
  const t = useT();
  const toast = useToast();
  const assistant = useAssistant();
  const usage = useUsage();

  const loadOverview = useCallback(async () => {
    try {
      const d = await api.projects();
      setOverview(d);
      setOverviewErr(null);
    } catch (e) {
      setOverviewErr(e);
    }
  }, []);

  const loadDoctor = useCallback(async (refresh = false) => {
    try {
      const d = await api.doctor(refresh);
      setDoctor(d);
      setDoctorErr(null);
    } catch (e) {
      setDoctorErr(e);
    }
  }, []);

  const loadPresets = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([api.presets(), api.channels().catch(() => null)]);
      setPresetsData(p);
      setPresetsErr(null);
      if (Array.isArray(c)) setChannels(c);
    } catch (e) {
      setPresetsErr(e);
    }
  }, []);

  // Trạng thái lệnh `claude auth` (đang chờ đăng nhập? kết quả lần trước?).
  const loadAccount = useCallback(async () => {
    try {
      setAccount(await api.account());
    } catch {
      /* server cũ / chưa bật → bỏ qua */
    }
  }, []);

  // Trạng thái YouTube (kênh, kết nối, hạn mức) — chỉ tải khi đang ở trang Kênh.
  const loadYoutube = useCallback(async () => {
    try {
      setYt(await api.youtube());
      setYtErr(null);
      // Kênh YouTube thêm/xóa trong app → danh sách kênh chung (lọc Tổng quan, Preset) cũng đổi.
      const c = await api.channels().catch(() => null);
      if (Array.isArray(c)) setChannels(c);
    } catch (e) {
      setYtErr(e);
    }
  }, []);
  const onChannels = route.name === 'channels' || route.name === 'channel' || route.name === 'channelsSetup';
  const onChannelsRef = useRef(onChannels);
  onChannelsRef.current = onChannels;

  useEffect(() => {
    loadDoctor();
    loadOverview();
    loadPresets();
    loadAccount();
    api.auth().then((a) => setCanLogout(!!(a?.password || a?.google?.enabled)), () => {});
  }, [loadDoctor, loadOverview, loadPresets, loadAccount]);

  // Đăng xuất khỏi Video Studio → tải lại trang (server trả trang đăng nhập).
  const logout = async () => {
    try {
      await api.logout();
    } catch {
      /* vẫn tải lại */
    }
    window.location.assign('/');
  };

  // Lệnh auth vừa xong (last.at đổi) → báo kết quả + đọc lại doctor; lần tải đầu chỉ ghi nhớ, không báo.
  useEffect(() => {
    if (!account) return;
    const at = account.last?.at ?? null;
    if (lastAuthAt.current === undefined) {
      lastAuthAt.current = at;
      return;
    }
    if (account.busy || at === lastAuthAt.current) return;
    lastAuthAt.current = at;
    const r = accountResultMessage(account.last);
    if (r) toast(r.msg, r.kind);
    loadDoctor(true);
    if (account.last?.ok) setAccountOpen(false);
  }, [account, toast, loadDoctor]);

  // Server gửi 'change' mỗi khi state đổi → gom lại 150 ms rồi tải lại số liệu tổng.
  useSSE((msg) => {
    if (msg.type === 'update') {
      setUpdate(msg.data);
      return;
    }
    if (msg.type === 'reconnect') api.update().then(setUpdate, () => {});
    if (msg.type === 'account') {
      setAccount(msg.data);
      return;
    }
    if ((msg.type === 'youtube' || msg.type === 'reconnect') && onChannelsRef.current) {
      clearTimeout(ytTimer.current);
      ytTimer.current = setTimeout(loadYoutube, 150);
    }
    if (msg.type === 'youtube') return;
    if (msg.type === 'reconnect') loadAccount();
    if (msg.type !== 'change' && msg.type !== 'reconnect') return;
    clearTimeout(timer.current);
    timer.current = setTimeout(loadOverview, 150);
  });
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      clearTimeout(ytTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (onChannels) loadYoutube();
  }, [onChannels, loadYoutube]);

  // Vào trang Preset thì đọc lại YAML (server đọc lại mỗi lần gọi).
  useEffect(() => {
    if (route.name === 'presets') loadPresets();
  }, [route.name, loadPresets]);

  // Bản mới: hỏi server khi mở app (server tự cache 6 giờ).
  const [update, setUpdate] = useState(null);
  useEffect(() => {
    api.update().then(setUpdate, () => {});
  }, []);

  const running = overview?.stats?.running ?? 0;
  useEffect(() => {
    document.body.classList.toggle('busy', running > 0);
  }, [running]);

  useEffect(() => {
    const TITLES = { presets: t('Quy trình · Video Studio'), channels: t('Kênh · Video Studio'), channelsSetup: t('Thiết lập Google · Video Studio'), skills: 'Skills · Video Studio', tts: t('Giọng đọc · Video Studio') };
    if (route.name !== 'step' && route.name !== 'channel') document.title = TITLES[route.name] || 'Video Studio';
  }, [route.name, t]);

  // Sidebar trợ lý mở → nội dung co lại (CSS body.ai-open).
  useEffect(() => {
    document.body.classList.toggle('ai-open', assistant.open);
  }, [assistant.open]);
  // giữ sidebar trong DOM thêm một nhịp để chạy hiệu ứng thu vào rồi mới gỡ
  const [aiMounted, setAiMounted] = useState(assistant.open);
  useEffect(() => {
    if (assistant.open) {
      setAiMounted(true);
      return undefined;
    }
    const id = setTimeout(() => setAiMounted(false), 240);
    return () => clearTimeout(id);
  }, [assistant.open]);

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    storeTheme(next);
    setTheme(next);
  };

  const banner = bannerError(overviewErr) || bannerError(doctorErr) || null;

  let page;
  if (route.name === 'step') {
    page = <Step key={`${route.params.id}/${route.params.key || ''}`} projectId={route.params.id} stepKey={route.params.key} />;
  } else if (route.name === 'presets') {
    page = <Pipelines data={presetsData} error={presetsErr} channels={channels} onReload={loadPresets} onAskAI={assistant.prefill} aiBusy={!!assistant.data?.busy} />;
  } else if (route.name === 'tts') {
    page = <TTS />;
  } else if (route.name === 'skills') {
    page = <Skills onReloadPresets={loadPresets} />;
  } else if (route.name === 'channels') {
    page = <Channels yt={yt} error={ytErr} onReload={loadYoutube} presetsData={presetsData} doctor={doctor} />;
  } else if (route.name === 'channel') {
    page = <ChannelDetail key={route.params.id} id={route.params.id} yt={yt} error={ytErr} onReload={loadYoutube} />;
  } else if (route.name === 'channelsSetup') {
    page = <YouTubeSetup yt={yt} onReload={loadYoutube} />;
  } else if (route.name === 'overview') {
    page = (
      <Overview
        data={overview}
        error={overviewErr}
        doctor={doctor}
        presetsData={presetsData}
        channels={channels}
        onReloadPresets={loadPresets}
        onReload={loadOverview}
      />
    );
  } else {
    page = (
      <div className="card pad empty">
        <b>{t('Không có trang này.')}</b>
        <p className="note">
          <a href="#/">{t('Về Tổng quan')}</a>
        </p>
      </div>
    );
  }

  return (
    <>
      <Header route={route} doctor={doctor} doctorError={doctorErr} stats={overview?.stats} sse={sse} theme={theme} onToggleTheme={toggleTheme} onAccount={() => setAccountOpen(true)} canLogout={canLogout} onLogout={logout} onReset={() => setResetOpen(true)} onAssistant={() => assistant.setOpen((v) => !v)} assistantOpen={assistant.open} usage={usage} />
      <DoctorBanner doctor={doctor} error={banner} onRefresh={() => Promise.all([loadDoctor(true), loadOverview()])} onAccount={() => setAccountOpen(true)} />
      <UpdateBanner u={update} running={running} />
      <main>{page}</main>
      {aiMounted || assistant.open ? (
        <AssistantPanel a={assistant} loggedIn={doctor ? !!doctor.auth?.loggedIn : null} onAccount={() => setAccountOpen(true)} />
      ) : null}
      {resetOpen ? <ResetModal running={running} onClose={() => setResetOpen(false)} /> : null}
      {accountOpen ? (
        <ClaudeAccount doctor={doctor} account={account} running={running} usage={usage} onClose={() => setAccountOpen(false)} onRefresh={() => Promise.all([loadDoctor(true), loadAccount()])} />
      ) : null}
    </>
  );
}
