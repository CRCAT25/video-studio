// Hub Server-Sent Events (hợp đồng M1 §9.3): giữ kết nối, broadcast, ping 15 s, tự gỡ client rớt.
import { SECURITY_HEADERS } from './auth.js';

const MAX_BUFFERED = 4 * 1024 * 1024; // client đọc chậm quá ngưỡng này → ngắt để không phình bộ nhớ

// Đóng gói một sự kiện SSE: "event: <tên>\ndata: <json>\n\n" (JSON không chứa xuống dòng thô).
export function formatEvent(event, data) {
  const json = JSON.stringify(data === undefined ? null : data);
  return `event: ${String(event).replace(/[\r\n]/g, '')}\ndata: ${json}\n\n`;
}

// Tạo hub SSE: {add(reply, hello?), broadcast(event, data), size(), closeAll()}.
// opts.hello: dữ liệu (hoặc hàm trả dữ liệu) gửi kèm event 'hello' khi client kết nối; opts.pingMs mặc định 15 000.
export function createHub({ pingMs = 15_000, hello = null, headers = {} } = {}) {
  const clients = new Set();
  let timer = null;

  function drop(c) {
    if (!clients.delete(c)) return;
    try {
      if (!c.res.writableEnded) c.res.end();
    } catch {
      /* đã đóng */
    }
    if (clients.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function write(c, chunk) {
    const res = c.res;
    if (res.destroyed || res.writableEnded) return drop(c);
    if (res.writableLength > MAX_BUFFERED) {
      res.destroy();
      return drop(c);
    }
    try {
      res.write(chunk);
    } catch {
      drop(c);
    }
  }

  function ensurePing() {
    if (timer || !(pingMs > 0)) return;
    timer = setInterval(() => {
      for (const c of [...clients]) write(c, ': ping\n\n');
    }, pingMs);
    timer.unref?.();
  }

  // Nhận một reply Fastify (hoặc http.ServerResponse), chiếm quyền phản hồi và giữ kết nối mở.
  function add(reply, helloData = undefined) {
    const res = reply && reply.raw ? reply.raw : reply;
    if (reply && typeof reply.hijack === 'function') reply.hijack();
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });
    res.socket?.setNoDelay?.(true);
    res.socket?.setTimeout?.(0);
    const c = { res };
    clients.add(c);
    const onClose = () => drop(c); // 'close' của response = kết nối đứt (req 'close' bắn sớm ở Node ≥16)
    res.on('close', onClose);
    res.on('error', onClose);
    write(c, 'retry: 3000\n\n');
    const h = helloData !== undefined ? helloData : typeof hello === 'function' ? hello() : hello;
    if (h != null) write(c, formatEvent('hello', h));
    ensurePing();
    return () => drop(c);
  }

  // Gửi một sự kiện tới mọi client đang kết nối; trả số client đã gửi.
  function broadcast(event, data) {
    if (clients.size === 0) return 0;
    const chunk = formatEvent(event, data);
    let n = 0;
    for (const c of [...clients]) {
      write(c, chunk);
      if (clients.has(c)) n++;
    }
    return n;
  }

  // Số client đang kết nối.
  function size() {
    return clients.size;
  }

  // Đóng mọi kết nối (khi server tắt) và dừng ping.
  function closeAll() {
    for (const c of [...clients]) drop(c);
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { add, broadcast, size, closeAll };
}
