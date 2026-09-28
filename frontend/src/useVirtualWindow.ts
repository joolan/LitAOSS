import { useState, useEffect, useLayoutEffect, useCallback, RefObject } from 'react';

export interface VirtualWindow {
  active: boolean;
  startUnit: number;
  endUnit: number;
  padTop: number;
  padBottom: number;
}

const INACTIVE: VirtualWindow = {
  active: false,
  startUnit: 0,
  endUnit: 0,
  padTop: 0,
  padBottom: 0,
};

// 大目录窗口化渲染：按滚动位置只渲染可视区附近的 unit（列表=行，网格=整行），
// 其余用上下占位撑起滚动条。unit i 恒位于容器顶部起 i*stride 处，
// 因此 padTop/start 采用绝对换算，占位与实际渲染自动对齐。
export function useVirtualWindow(
  containerRef: RefObject<HTMLElement | null>,
  unitCount: number,
  stride: number,
  enabled: boolean,
  overscan = 6,
): VirtualWindow {
  const [state, setState] = useState<VirtualWindow>(INACTIVE);

  const recompute = useCallback(() => {
    const el = containerRef.current;
    if (!enabled || !el || unitCount <= 0 || stride <= 0) {
      setState((s) => (s.active ? INACTIVE : s));
      return;
    }
    const rect = el.getBoundingClientRect();
    const y0 = -rect.top;
    const overscanPx = overscan * stride;
    const start = Math.min(
      unitCount,
      Math.max(0, Math.floor((y0 - overscanPx) / stride)),
    );
    const end = Math.min(
      unitCount,
      Math.max(start, Math.ceil((y0 + window.innerHeight + overscanPx) / stride)),
    );
    setState((s) => {
      if (s.active && s.startUnit === start && s.endUnit === end) return s;
      return {
        active: true,
        startUnit: start,
        endUnit: end,
        padTop: start * stride,
        padBottom: (unitCount - end) * stride,
      };
    });
  }, [containerRef, unitCount, stride, enabled, overscan]);

  // 首帧在绘制前同步算好窗口，避免大目录先全量渲染再收窗口的闪烁
  useLayoutEffect(() => {
    recompute();
  }, [recompute]);

  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        recompute();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [recompute, enabled]);

  return state;
}
