import { useEffect, useRef, useState, type ReactNode } from 'react';

interface VirtualListProps<T> {
  items: T[];
  rowHeight: number;
  height: number;
  renderRow: (item: T, index: number) => ReactNode;
  /** 外部要求滚动到的下标（例如冲突定位）；变化即滚动 */
  scrollToIndex?: number | null;
  overscan?: number;
}

/**
 * 极简定高虚拟列表：支撑 200000 块/页面的流畅渲染。
 */
export function VirtualList<T>({
  items,
  rowHeight,
  height,
  renderRow,
  scrollToIndex = null,
  overscan = 12,
}: VirtualListProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    if (scrollToIndex == null || !ref.current) return;
    const top = scrollToIndex * rowHeight;
    const viewTop = ref.current.scrollTop;
    const viewBottom = viewTop + height;
    if (top < viewTop || top + rowHeight > viewBottom) {
      ref.current.scrollTop = Math.max(0, top - height / 2 + rowHeight / 2);
    }
  }, [scrollToIndex, rowHeight, height]);

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(height / rowHeight) + overscan * 2;
  const end = Math.min(items.length, start + visible);

  const rows: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    rows.push(
      <div key={i} className="vrow" style={{ transform: `translateY(${i * rowHeight}px)` }}>
        {renderRow(items[i], i)}
      </div>,
    );
  }

  return (
    <div
      ref={ref}
      className="vlist"
      style={{ height, position: 'relative', overflow: 'auto' }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: items.length * rowHeight, position: 'relative' }}>{rows}</div>
    </div>
  );
}
