import type { PresentationRenderTokenClaims } from '@studio/shared';
import { verifyPresentationRenderToken } from './auth.js';
import { PresentationRenderError } from './presentationRender.js';

/**
 * The deck renderer runs LibreOffice on the instance that carries the live
 * relay, so in production it only serves admitted hosts and co-hosts: their
 * studio asks signaling for a 'presentation-render' token and sends it as a
 * bearer token. PRESENTATION_RENDER_REQUIRE_AUTH=false opens it (not
 * recommended); =true also requires it outside production.
 */
export function isPresentationRenderAuthRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PRESENTATION_RENDER_REQUIRE_AUTH === 'false') return false;
  if (env.PRESENTATION_RENDER_REQUIRE_AUTH === 'true') return true;
  return env.NODE_ENV === 'production';
}

export function authorizePresentationRender(
  token: string,
  secret: string | null,
  now = Date.now()
): PresentationRenderTokenClaims {
  if (!secret) {
    throw new PresentationRenderError(503, 'PRESENTATION_RENDER_NOT_CONFIGURED', 'Presentation rendering is not configured on this server');
  }
  if (!token) {
    throw new PresentationRenderError(401, 'UNAUTHORIZED', 'Presentation rendering requires a studio token');
  }
  try {
    return verifyPresentationRenderToken(token, secret, now);
  } catch {
    throw new PresentationRenderError(401, 'UNAUTHORIZED', 'Invalid or expired presentation rendering token');
  }
}
