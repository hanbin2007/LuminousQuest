import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(notify: () => void) {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
}

function snapshot() {
  return typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches;
}

/** 订阅式 reduced-motion:系统设置会话中途变化时,JS 侧与 CSS 媒体查询同步生效。 */
export function useReducedMotion() {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
