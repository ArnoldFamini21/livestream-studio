import type { CSSProperties } from 'react';

const paths: Record<string, React.ReactNode> = {
  studios: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m10 9 5 3-5 3Z" /></>,
  video: <><rect x="3" y="6" width="12" height="12" rx="3" /><path d="m15 10 6-3v10l-6-3" /></>,
  recordings: <><rect x="4" y="3" width="16" height="18" rx="3" /><path d="m10 9 5 3-5 3Z" /></>,
  brand: <><path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-4c-1-1 0-3 2-3h2c4 0 3-11-6-11Z" /><path d="M7 10h.01M9 6.5h.01M14 6.5h.01M17 10h.01" strokeWidth="3" /></>,
  team: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5v2" /></>,
  person: <><circle cx="12" cy="8" r="4" /><path d="M4 22v-2a8 8 0 0 1 16 0v2" /></>,
  settings: <><path d="m9 3-.5 3-3 1-2.5 2 2 3-2 3 2.5 2 3 1 .5 3h6l.5-3 3-1 2.5-2-2-3 2-3-2.5-2-3-1L15 3Z" /><circle cx="12" cy="12" r="3" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  chevron: <path d="m8 10 4 4 4-4" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></>,
  'mic-off': <><path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 10V6a3 3 0 0 0-5.2-2M5 10v2a7 7 0 0 0 11.5 5.4M19 10v2M12 19v3M8 22h8M3 3l18 18" /></>,
  'video-off': <><path d="M3 8v7a3 3 0 0 0 3 3h8M8 6h4a3 3 0 0 1 3 3v1l6-3v10l-4-2M3 3l18 18" /></>,
  screen: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M12 16v4m-5 0h10" /></>,
  chat: <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-6 4V7a2 2 0 0 1 2-2Z" />,
  record: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" fill="currentColor" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />,
};

export function StudioIcon({ name, style }: { name: string; style?: CSSProperties }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name] || paths.studios}</svg>;
}
