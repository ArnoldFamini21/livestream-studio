/**
 * Turns a session's User-Agent into a short label people recognize, such as
 * "Chrome on macOS" or "Safari on iPhone".
 */

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg(A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const PLATFORMS: Array<[RegExp, string]> = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

export function describeUserAgent(userAgent: string): string {
  const ua = userAgent.trim();
  if (!ua) return 'Unknown device';
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1];
  const platform = PLATFORMS.find(([pattern]) => pattern.test(ua))?.[1];
  if (browser && platform) return `${browser} on ${platform}`;
  return browser || platform || 'Unknown device';
}

/** "Active now", "Active 5 min ago", "Active 3 days ago". */
export function describeLastActive(lastSeenAt: string, now = Date.now()): string {
  const time = Date.parse(lastSeenAt);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 6) return 'Active now';
  if (minutes < 60) return `Active ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Active ${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `Active ${days} day${days === 1 ? '' : 's'} ago`;
}
