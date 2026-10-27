// Dấu * đỏ báo trường bắt buộc (chỉ để nhìn; trường vẫn nên có aria-required).
import { useT } from '../lib/i18n.jsx';

export default function Req() {
  const t = useT();
  return <i className="req" title={t('Bắt buộc')} aria-hidden="true">*</i>;
}
