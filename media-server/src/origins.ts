const DEFAULT_ALLOWED_ORIGINS = [
  'https://studio.arnoldfamini.com',
  'http://localhost:5173',
];

export function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function addAllowedOrigins(allowedOrigins: Set<string>, value?: string) {
  if (!value) return;
  for (const item of value.split(',')) {
    const origin = normalizeOrigin(item.trim());
    if (origin) allowedOrigins.add(origin);
  }
}

export function buildAllowedOrigins(...configuredValues: Array<string | undefined>): Set<string> {
  const allowedOrigins = new Set<string>(DEFAULT_ALLOWED_ORIGINS);
  for (const value of configuredValues) {
    addAllowedOrigins(allowedOrigins, value);
  }
  return allowedOrigins;
}

export function isAllowedOrigin(
  origin: string | undefined,
  options: { allowedOrigins: Set<string>; production: boolean }
): boolean {
  if (!origin) return !options.production;
  const normalized = normalizeOrigin(origin);
  return Boolean(normalized && options.allowedOrigins.has(normalized));
}
