// Luật Origin cho proxy dev của Vite (tách riêng để test được, không import vite).

// Origin mà proxy được phép đổi sang địa chỉ server: chỉ khi request đến từ chính trang Vite (Origin === http://<Host>).
// Origin khác giữ nguyên → server trả 403 forbidden_origin như khi gọi thẳng. Trả origin mới hoặc null (không đổi).
export function proxiedOrigin(headers, target) {
  const origin = headers?.origin;
  const host = headers?.host;
  if (typeof origin !== 'string' || !origin || typeof host !== 'string' || !host) return null;
  return origin.toLowerCase() === `http://${host}`.toLowerCase() ? target : null;
}
