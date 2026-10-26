// Khung chờ (skeleton) cho nội dung tải từ API: giữ đúng hình dạng nội dung thật để tải xong không xô layout.

// Một vệt chờ. Mặc định là vệt chữ inline (cao 0.8em, nằm trong dòng chữ thật nên giữ đúng line-height);
// block = khối có kích thước (ô bước, biểu đồ…).
export function Sk({ w, h, r, block = false, className = '', style }) {
  return <span className={`sk${block ? ' blk' : ''}${className ? ` ${className}` : ''}`} style={{ width: w, height: h, borderRadius: r, ...style }} aria-hidden="true" />;
}

// Vùng đang tải: aria-busy + chữ "Đang tải" cho trình đọc màn hình; hiện mờ dần sau 150 ms để lần tải nhanh không nhấp nháy.
export function SkZone({ as: Tag = 'div', label = 'Đang tải', className = '', children, ...rest }) {
  return (
    <Tag className={`sk-zone${className ? ` ${className}` : ''}`} aria-busy="true" {...rest}>
      <span className="sr-only" role="status">
        {label}
      </span>
      {children}
    </Tag>
  );
}

// Vài dòng chữ giả, dòng cuối ngắn hơn; cls = lớp chữ thật của mỗi dòng (để đúng cỡ chữ).
export function SkLines({ n = 3, widths = ['92%', '78%', '86%', '60%'], cls = 'sk-line' }) {
  return Array.from({ length: n }, (_, i) => (
    <div key={i} className={cls}>
      <Sk w={i === n - 1 ? '45%' : widths[i % widths.length]} />
    </div>
  ));
}

// Dải ô bước giả, cùng kích thước Flow thật (lg = Flow lớn ở trang bước).
export function SkFlow({ n = 6, lg = false }) {
  return (
    <div className={`flow sk-flow${lg ? ' lg' : ''}`}>
      <div className="belt">
        {Array.from({ length: n }, (_, i) => (
          <Sk key={i} block className="sk-box" />
        ))}
      </div>
    </div>
  );
}
