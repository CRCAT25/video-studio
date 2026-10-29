// Sơ đồ tư duy của Bộ não: "Bộ não" ở giữa, các nhánh gốc tỏa hai bên, rồi nhánh con, rồi từng ghi nhớ.
// Tự tính bố cục và vẽ SVG (không thư viện); bấm nhánh để thu/mở, bấm ghi nhớ để sửa, kéo để di chuyển.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../lib/i18n.jsx';

const ROW = 34; // chiều cao một hàng lá
const GROUP_GAP = 14; // khoảng trống giữa hai nhánh gốc
const COL_GAP = 56; // khoảng cách ngang giữa hai cấp
const NODE_H = { center: 40, root: 30, sub: 28, item: 26 };
const PAD = 12; // lề chữ trong node
const MAX_CHARS = 46; // ghi nhớ dài hơn thì cắt, rê chuột xem đủ
const OPEN_ALL_MAX = 40; // ít ghi nhớ thì mở hết sẵn, nhiều thì chỉ mở tới nhánh
const K_MIN = 0.15;
const K_MAX = 2;

// Cắt chữ dài thành một dòng có dấu "…".
function clip(s) {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > MAX_CHARS ? `${one.slice(0, MAX_CHARS - 1)}…` : one;
}

// Đo bề rộng chữ bằng canvas (cùng font với trang) để node vừa khít nội dung.
function useMeasure() {
  return useMemo(() => {
    const ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    const fam = typeof document !== 'undefined' ? getComputedStyle(document.body).fontFamily : 'sans-serif';
    return (text, size = 13, weight = 400) => {
      if (!ctx) return text.length * size * 0.6;
      ctx.font = `${weight} ${size}px ${fam}`;
      return ctx.measureText(text).width;
    };
  }, []);
}

// Dựng cây node từ dữ liệu bộ não: gốc → (nhánh con) → ghi nhớ.
function buildTree(data, rootLabel) {
  return data.roots.map((root) => {
    const own = data.branches.filter((b) => b.path === root);
    const subs = data.branches.filter((b) => b.path.startsWith(`${root}/`));
    const item = (b) => (it) => ({ id: `i:${it.id}`, kind: 'item', label: clip(it.text), full: it.text, it: { ...it, branch: b.path }, kids: [] });
    const kids = [
      ...own.flatMap((b) => b.items.map(item(b))),
      ...subs.map((b) => {
        const sub = b.path.slice(root.length + 1);
        return { id: `s:${b.path}`, kind: 'sub', label: sub, count: b.items.length, kids: b.items.map(item(b)) };
      }),
    ];
    const count = [...own, ...subs].reduce((n, b) => n + b.items.length, 0);
    return { id: `r:${root}`, kind: 'root', label: rootLabel(root), count, kids };
  });
}

// Chia nhánh gốc sang hai bên cho cân số hàng, giữ đúng thứ tự (nửa đầu phải, nửa sau trái).
function splitSides(roots, rows) {
  const total = roots.reduce((n, r) => n + rows(r), 0);
  const right = [];
  let acc = 0;
  let i = 0;
  for (; i < roots.length; i++) {
    if (right.length && acc + rows(roots[i]) / 2 > total / 2) break;
    right.push(roots[i]);
    acc += rows(roots[i]);
  }
  return { right, left: roots.slice(i) };
}

// Tính vị trí mọi node đang hiện: trả {nodes, edges, box}. open = tập id nhánh đang mở.
function layout(tree, open, centerLabel, measure) {
  const shown = (n) => (n.kids.length && open.has(n.id) ? n.kids : []);
  const rows = (n) => {
    const k = shown(n);
    return k.length ? k.reduce((s, c) => s + rows(c), 0) : 1;
  };
  const width = (n) => {
    const size = n.kind === 'center' ? 16 : 13;
    const weight = n.kind === 'center' || n.kind === 'root' ? 600 : 400;
    const extra = n.count != null ? measure(` ${n.count}`, 12) + 8 : 0;
    return Math.ceil(measure(n.label, size, weight) + extra + PAD * 2);
  };
  // Bề rộng lớn nhất ở mỗi cấp (cả hai bên) để các cột thẳng hàng.
  const maxW = [];
  const visit = (n, d) => {
    maxW[d] = Math.max(maxW[d] || 0, width(n));
    shown(n).forEach((c) => visit(c, d + 1));
  };
  tree.forEach((r) => visit(r, 1));
  const center = { id: 'c', kind: 'center', label: centerLabel, kids: [] };
  const cw = width(center);
  const colX = [0, cw / 2 + COL_GAP];
  for (let d = 2; d < maxW.length; d++) colX[d] = colX[d - 1] + maxW[d - 1] + COL_GAP;

  const nodes = [{ ...center, x: -cw / 2, y: 0, w: cw, h: NODE_H.center, side: 0 }];
  const edges = [];
  const placeSide = (roots, side) => {
    const out = [];
    let y = 0;
    const place = (n, d, parent) => {
      const w = width(n);
      const node = { ...n, w, h: NODE_H[n.kind], side, depth: d, x: side > 0 ? colX[d] : -colX[d] - w, open: open.has(n.id) };
      const k = shown(n);
      if (k.length) {
        const placed = k.map((c) => place(c, d + 1, node));
        node.y = (placed[0].y + placed[placed.length - 1].y) / 2;
      } else {
        node.y = y + ROW / 2;
        y += ROW;
      }
      out.push({ node, parent });
      return node;
    };
    roots.forEach((r, i) => {
      if (i) y += GROUP_GAP;
      place(r, 1, null);
    });
    const shift = -y / 2; // canh giữa bên này quanh y = 0
    out.forEach(({ node }) => (node.y += shift));
    out.forEach(({ node, parent }) => {
      nodes.push(node);
      const p = parent || nodes[0];
      const x1 = side > 0 ? p.x + p.w : p.x;
      const x2 = side > 0 ? node.x : node.x + node.w;
      edges.push({ id: `${p.id}>${node.id}`, x1, y1: p.y, x2, y2: node.y });
    });
  };
  const { right, left } = splitSides(tree, rows);
  placeSide(right, 1);
  placeSide(left, -1);

  const box = nodes.reduce(
    (b, n) => ({ x0: Math.min(b.x0, n.x), x1: Math.max(b.x1, n.x + n.w), y0: Math.min(b.y0, n.y - n.h / 2), y1: Math.max(b.y1, n.y + n.h / 2) }),
    { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity },
  );
  return { nodes, edges, box };
}

// Mặc định: ít ghi nhớ thì mở hết; nhiều thì chỉ mở nhánh gốc có nhánh con (để thấy tên kênh/bước).
function defaultOpen(tree) {
  const total = tree.reduce((n, r) => n + r.count, 0);
  const open = new Set();
  tree.forEach((r) => {
    if (!r.kids.length) return;
    if (total <= OPEN_ALL_MAX) {
      open.add(r.id);
      r.kids.forEach((k) => k.kind === 'sub' && open.add(k.id));
    } else if (r.kids.some((k) => k.kind === 'sub')) open.add(r.id);
  });
  return open;
}

// data = kết quả api.brain(); onEdit(it) mở hộp sửa ghi nhớ; rootLabel dịch tên gốc.
export default function BrainMap({ data, onEdit, rootLabel }) {
  const t = useT();
  const measure = useMeasure();
  const tree = useMemo(() => buildTree(data, rootLabel), [data, rootLabel]);
  const [open, setOpen] = useState(() => defaultOpen(tree));
  const [fonts, setFonts] = useState(0); // tăng khi web font tải xong → đo lại chữ cho đúng
  useEffect(() => {
    let live = true;
    document.fonts?.ready.then(() => live && setFonts(1));
    return () => { live = false; };
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { nodes, edges, box } = useMemo(() => layout(tree, open, t('Bộ não'), measure), [tree, open, t, measure, fonts]);
  const wrap = useRef(null);
  const [view, setView] = useState(null); // {k, x, y}: phóng to và dịch
  const drag = useRef(null);

  // Vừa khung: tính tỉ lệ và vị trí để cả sơ đồ nằm gọn giữa khung.
  const fit = useCallback(() => {
    const el = wrap.current;
    if (!el) return;
    const bw = box.x1 - box.x0 || 1;
    const bh = box.y1 - box.y0 || 1;
    const k = Math.max(K_MIN, Math.min(1, (el.clientWidth - 48) / bw, (el.clientHeight - 48) / bh));
    setView({ k, x: el.clientWidth / 2 - k * (box.x0 + bw / 2), y: el.clientHeight / 2 - k * (box.y0 + bh / 2) });
  }, [box]);
  const fitted = useRef(false);
  useLayoutEffect(() => {
    if (!fitted.current) {
      fitted.current = true;
      fit();
    }
  }, [fit]);

  // Phóng to/thu nhỏ quanh một điểm trong khung (mặc định là tâm khung).
  const zoom = useCallback((f, cx, cy) => {
    const el = wrap.current;
    setView((v) => {
      if (!v || !el) return v;
      const k = Math.max(K_MIN, Math.min(K_MAX, v.k * f));
      const px = cx ?? el.clientWidth / 2;
      const py = cy ?? el.clientHeight / 2;
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  }, []);

  // Ctrl/⌘ + cuộn (hoặc chụm hai ngón trên trackpad) để phóng; cuộn thường vẫn cuộn trang.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoom(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom]);

  // Kéo nền để di chuyển; kéo quá 4px thì không tính là bấm node.
  const onDown = (e) => {
    if (e.button !== 0 || !view) return;
    drag.current = { sx: e.clientX, sy: e.clientY, x: view.x, y: view.y, moved: false };
  };
  const onMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId); // chỉ giữ chuột khi đã kéo thật, để bấm node vẫn nhận click
    }
    setView((v) => ({ ...v, x: d.x + dx, y: d.y + dy }));
  };
  const onUp = () => {
    setTimeout(() => (drag.current = null), 0); // để click ngay sau đó còn biết vừa kéo
  };

  // Bấm node: nhánh thì thu/mở, ghi nhớ thì mở hộp sửa.
  const activate = (n) => {
    if (drag.current?.moved) return;
    if (n.kind === 'item') return onEdit(n.it);
    if (!n.kids.length) return;
    setOpen((o) => {
      const s = new Set(o);
      if (s.has(n.id)) s.delete(n.id);
      else s.add(n.id);
      return s;
    });
  };
  const onKey = (n) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(n);
    }
  };

  // Mở hết / thu hết các nhánh.
  const expandAll = () => {
    const s = new Set();
    tree.forEach((r) => {
      if (r.kids.length) s.add(r.id);
      r.kids.forEach((k) => k.kids.length && s.add(k.id));
    });
    setOpen(s);
  };

  const edge = (e) => {
    const mx = (e.x1 + e.x2) / 2;
    return `M${e.x1},${e.y1} C${mx},${e.y1} ${mx},${e.y2} ${e.x2},${e.y2}`;
  };

  return (
    <section className="card br-map" aria-label={t('Sơ đồ bộ não')}>
      <div className="br-map-bar">
        <span className="hint">{t('Bấm nhánh để thu/mở, bấm ghi nhớ để sửa. Kéo để di chuyển, Ctrl/⌘ + cuộn để phóng to.')}</span>
        <span className="br-acts">
          <button type="button" className="btn sm ghost" onClick={expandAll}>{t('Mở hết')}</button>
          <button type="button" className="btn sm ghost" onClick={() => setOpen(new Set())}>{t('Thu hết')}</button>
          <button type="button" className="btn sm" onClick={() => zoom(1 / 1.25)} aria-label={t('Thu nhỏ')} title={t('Thu nhỏ')}>−</button>
          <button type="button" className="btn sm" onClick={() => zoom(1.25)} aria-label={t('Phóng to')} title={t('Phóng to')}>+</button>
          <button type="button" className="btn sm" onClick={fit}>{t('Vừa khung')}</button>
        </span>
      </div>
      <div className="br-map-view" ref={wrap} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {view ? (
          <svg className="br-map-svg" width="100%" height="100%">
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {edges.map((e) => <path key={e.id} className="br-edge" d={edge(e)} />)}
              {nodes.map((n) => {
                const branch = n.kind !== 'center' && n.kind !== 'item' && n.kids.length > 0;
                const cls = ['br-n', `br-n-${n.kind}`, n.kind === 'root' && !n.count ? 'empty' : '', branch && !n.open ? 'closed' : ''].filter(Boolean).join(' ');
                const live = n.kind === 'item' || branch;
                const label = n.kind === 'item' ? t('Sửa ghi nhớ: {s}', { s: n.full }) : branch ? `${n.label} · ${t('{n} mục', { n: n.count })} · ${n.open ? t('thu lại') : t('mở ra')}` : undefined;
                return (
                  <g
                    key={n.id}
                    className={cls}
                    transform={`translate(${n.x},${n.y})`}
                    onClick={live ? () => activate(n) : undefined}
                    onKeyDown={live ? onKey(n) : undefined}
                    tabIndex={live ? 0 : undefined}
                    role={live ? 'button' : undefined}
                    aria-label={label}
                    aria-expanded={branch ? n.open : undefined}
                  >
                    {n.kind === 'item' ? <title>{n.full}</title> : null}
                    <rect x={0} y={-n.h / 2} width={n.w} height={n.h} rx={n.kind === 'center' ? n.h / 2 : 6} />
                    <text x={PAD} y={0} dominantBaseline="central">
                      {n.label}
                      {n.count != null ? <tspan className="br-n-count" dx={6}>{n.count}</tspan> : null}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        ) : null}
      </div>
    </section>
  );
}
