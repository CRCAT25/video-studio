// Đầu trang: logo, menu, mức dùng gói, nút Trợ lý AI và menu Tài khoản (Claude, ngôn ngữ, sáng/tối, đăng xuất).
import { Logo } from './icons.jsx';
import AccountMenu from './AccountMenu.jsx';
import { UsageMeter } from './Usage.jsx';
import { useT } from '../lib/i18n.jsx';

// Nhãn trạng thái Claude Code (không bao giờ hiện email/tổ chức): {text, tone}.
function claudeStatus(doctor, doctorError, t) {
  if (doctorError) return { text: t('Không rõ'), lamp: 'err', bad: true };
  if (!doctor) return { text: t('Đang kiểm tra'), lamp: 'idle', bad: false, loading: true };
  if (!doctor.claude?.found) return { text: t('Chưa cài Claude Code'), lamp: 'err', bad: true };
  return doctor.auth?.loggedIn ? { text: t('Đã đăng nhập'), lamp: 'ok', bad: false } : { text: t('Chưa đăng nhập'), lamp: 'err', bad: true };
}

// Thanh đầu trang; stats = {running, waiting}.
export default function Header({ route, doctor, doctorError, stats, theme, onToggleTheme, onAccount, canLogout = false, onLogout, onAssistant, assistantOpen = false, usage = null }) {
  const t = useT();
  const waiting = stats?.waiting ?? 0;
  const onOverview = route.name === 'overview' || route.name === 'step';
  const onChannels = route.name === 'channels' || route.name === 'channel' || route.name === 'channelsSetup';
  const st = claudeStatus(doctor, doctorError, t);
  return (
    <header className="top">
      <div className="top-in">
        <a className="brand" href="#/" title="Video Studio">
          <Logo />
          <span>Video Studio</span>
        </a>
        <nav className="tabs" aria-label={t('Điều hướng chính')}>
          <a href="#/" className={onOverview ? 'on' : ''} aria-current={onOverview ? 'page' : undefined}>
            {t('Tổng quan')}
            {waiting > 0 ? (
              <span className="badge" title={t('{n} việc chờ bạn', { n: waiting })}>
                {waiting}
              </span>
            ) : null}
          </a>
          <a href="#/quy-trinh" className={route.name === 'presets' ? 'on' : ''} aria-current={route.name === 'presets' ? 'page' : undefined}>
            {t('Quy trình')}
          </a>
          <a href="#/channels" className={onChannels ? 'on' : ''} aria-current={onChannels ? 'page' : undefined}>
            {t('Kênh')}
          </a>
        </nav>
        <div className="top-right">
          {usage && doctor?.auth?.loggedIn ? <UsageMeter usage={usage} onClick={onAccount} /> : null}
          <button type="button" className={`ai-btn${assistantOpen ? ' on' : ''}`} onClick={onAssistant} aria-pressed={assistantOpen} aria-label={t('Trợ lý AI')} title={t('Trợ lý AI — nhờ Claude thao tác trên trang')}>
            <span className="spark" aria-hidden="true">✦</span>
            <span className="ai-t">
              <span className="hide-m">{t('Trợ lý AI')}</span>
              <span className="show-m">AI</span>
            </span>
          </button>
          <AccountMenu st={st} theme={theme} onTheme={onToggleTheme} onAccount={onAccount} canLogout={canLogout} onLogout={onLogout} />
        </div>
      </div>
    </header>
  );
}
