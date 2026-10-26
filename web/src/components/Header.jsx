// Đầu trang: logo, menu, nút trạng thái Claude + mức dùng (mở bảng Tài khoản), nút Trợ lý AI, nút đổi sáng/tối và Đăng xuất (khi bật đăng nhập Google).
import { Logo } from './icons.jsx';
import { Sk } from './Skeleton.jsx';
import { UsageMeter } from './Usage.jsx';

// Nhãn trạng thái Claude Code (không bao giờ hiện email/tổ chức): {text, tone}.
function claudeStatus(doctor, doctorError) {
  if (doctorError) return { text: 'Không rõ', lamp: 'err', bad: true };
  if (!doctor) return { text: 'Đang kiểm tra', lamp: 'idle', bad: false, loading: true };
  if (!doctor.claude?.found) return { text: 'Chưa cài Claude Code', lamp: 'err', bad: true };
  return doctor.auth?.loggedIn ? { text: 'Đã đăng nhập', lamp: 'ok', bad: false } : { text: 'Chưa đăng nhập', lamp: 'err', bad: true };
}

// Thanh đầu trang; stats = {running, waiting}.
export default function Header({ route, doctor, doctorError, stats, theme, onToggleTheme, onAccount, canLogout = false, onLogout, onAssistant, assistantOpen = false, usage = null }) {
  const waiting = stats?.waiting ?? 0;
  const onOverview = route.name === 'overview' || route.name === 'step';
  const onChannels = route.name === 'channels' || route.name === 'channel' || route.name === 'channelsSetup';
  const st = claudeStatus(doctor, doctorError);
  return (
    <header className="top">
      <div className="top-in">
        <a className="brand" href="#/" title="Video Studio">
          <Logo />
          <span>Video Studio</span>
        </a>
        <nav className="tabs" aria-label="Điều hướng chính">
          <a href="#/" className={onOverview ? 'on' : ''} aria-current={onOverview ? 'page' : undefined}>
            Tổng quan
            {waiting > 0 ? (
              <span className="badge" title={`${waiting} việc chờ bạn`}>
                {waiting}
              </span>
            ) : null}
          </a>
          <a href="#/quy-trinh" className={route.name === 'presets' ? 'on' : ''} aria-current={route.name === 'presets' ? 'page' : undefined}>
            Quy trình
          </a>
          <a href="#/channels" className={onChannels ? 'on' : ''} aria-current={onChannels ? 'page' : undefined}>
            Kênh
          </a>
        </nav>
        <div className="top-right">
          <button type="button" className={`acc-btn${st.bad ? ' bad' : ''}`} onClick={onAccount} title="Tài khoản Claude" aria-label={`Tài khoản Claude: ${st.text}`}>
            <i className={`lamp ${st.lamp}`} />
            <span className="hide-m">Claude</span>
            <span className="acc-st" aria-busy={st.loading || undefined}>{st.loading ? <Sk w="6.5em" /> : st.text}</span>
          </button>
          {usage && doctor?.auth?.loggedIn ? <UsageMeter usage={usage} onClick={onAccount} /> : null}
          <button type="button" className={`ai-btn${assistantOpen ? ' on' : ''}`} onClick={onAssistant} aria-pressed={assistantOpen} aria-label="Trợ lý AI" title="Trợ lý AI — nhờ Claude thao tác trên trang">
            <span className="spark" aria-hidden="true">✦</span>
            <span className="ai-t">
              <span className="hide-m">Trợ lý </span>AI
            </span>
          </button>
          <button type="button" className="btn sm theme-btn" onClick={onToggleTheme} title="Đổi sáng / tối" aria-label={theme === 'light' ? 'Chuyển sang giao diện tối' : 'Chuyển sang giao diện sáng'}>
            ◐
          </button>
          {canLogout ? (
            <button type="button" className="btn sm" onClick={onLogout} title="Đăng xuất khỏi Video Studio (không đăng xuất Google / Claude)">
              Đăng xuất
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
