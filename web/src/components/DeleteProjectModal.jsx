// Hộp xác nhận xóa dự án (dùng chung Tổng quan + Danh sách dự án); ô tick (mặc định bật) chuyển thư mục file vào Thùng rác.
import { useState } from 'react';
import ConfirmModal from './ConfirmModal.jsx';
import { api } from '../api.js';
import { useT } from '../lib/i18n.jsx';

export default function DeleteProjectModal({ p, onDone, onClose }) {
  const t = useT();
  const [trash, setTrash] = useState(true);
  return (
    <ConfirmModal
      title={t('Xóa dự án "{n}"?', { n: p.title })}
      body={t('Dự án, các lượt chạy và nhật ký sẽ bị xóa khỏi app. Không hoàn tác được.')}
      okLabel={t('Xóa dự án')}
      danger
      onOk={async () => {
        const r = await api.deleteProject(p.id, trash);
        onDone(r);
      }}
      onClose={onClose}
    >
      <label className="chk">
        <input type="checkbox" checked={trash} onChange={(e) => setTrash(e.target.checked)} />
        <span>{t('Chuyển thư mục file của dự án vào Thùng rác')}</span>
      </label>
      <p className="hint mono">{p.dir}</p>
    </ConfirmModal>
  );
}
