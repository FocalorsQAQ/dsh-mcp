import type { ReactNode } from 'react';
export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    pin: <><path d="m8 3 5 5-2 2 1 3-2 2-3-1-2 2-1-1 2-2-1-3 2-2Z" /><path d="m3 17 4-4" /></>,
    minus: <path d="M5 10h10" />, plus: <path d="M5 10h10M10 5v10" />,
    close: <path d="m5 5 10 10M15 5 5 15" />,
    collapse: <><path d="m4 4 4 4M4 8h4V4m8 12-4-4m0 4v-4h4" /></>,
    expand: <><path d="M4 8V4h4M4 4l4 4m8 4v4h-4m4 0-4-4" /></>,
    agents: <><rect x="3" y="4" width="6" height="6" rx="2" /><rect x="11" y="10" width="6" height="6" rx="2" /><path d="M12 5h3v3M5 12v3h3" /></>,
    key: <><circle cx="7" cy="7" r="4" /><path d="m10 10 7 7m-3-3 2-2m-4 0 2-2" /></>,
    model: <><path d="m10 2 7 4v8l-7 4-7-4V6l7-4Z" /><path d="m3 6 7 4 7-4m-7 4v8" /></>,
    arrow: <path d="m7 5 5 5-5 5" />,
    activity: <path d="M2 10h4l2-6 4 12 2-6h4" />,
    clock: <><circle cx="10" cy="10" r="7" /><path d="M10 6v4l3 2" /></>,
    folder: <path d="M3 6V4h5l2 2h7v10H3V6Z" />,
    check: <path d="m4 10 4 4 8-8" />,
    refresh: <><path d="M16 7a6 6 0 1 0 0 6M16 3v4h-4" /></>,
    wallet: <><rect x="3" y="5" width="14" height="11" rx="2" /><path d="M14 5V3H5a2 2 0 0 0-2 2m14 4h-5v4h5" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.model}</svg>;
}
