// Đồng hồ cho UI: trả Date.now() cập nhật theo chu kỳ (dùng cho thời gian chạy đếm sống, "x phút trước").
import { useEffect, useState } from 'react';

// Trả mốc thời gian hiện tại (ms), cập nhật mỗi `ms`; enabled=false thì đứng yên.
export function useNow(ms = 1000, enabled = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, enabled]);
  return now;
}
