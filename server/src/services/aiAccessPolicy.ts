import { parseEmailList } from './studioAccessPolicy.js';

export type AiAccessPolicyMode = 'not-configured' | 'locked' | 'token' | 'allowlist' | 'any-account' | 'anonymous';

/**
 * How the AI routes are gated. They spend the owner's OpenAI budget, so with a
 * key configured they stay locked until the owner picks a policy: an operator
 * token, an account allowlist (OPENAI_ALLOWED_ACCOUNT_EMAILS, or the studio
 * owners in STUDIO_OWNER_EMAILS), or signed-in accounts. Anonymous use needs an
 * explicit OPENAI_ALLOW_ANONYMOUS=true (local development).
 */
export function getAiAccessPolicy(env: NodeJS.ProcessEnv = process.env): {
  mode: AiAccessPolicyMode;
  allowedEmails: Set<string>;
  token: string;
  requireAccount: boolean;
} {
  const token = (env.OPENAI_ACCESS_TOKEN || '').trim();
  const aiAllowlist = parseEmailList(env.OPENAI_ALLOWED_ACCOUNT_EMAILS);
  const accountFlag = env.OPENAI_REQUIRE_ACCOUNT_AUTH === 'true';
  // Studio owners are the natural AI users when no AI-specific policy exists.
  const allowedEmails = aiAllowlist.size > 0 || token || accountFlag ? aiAllowlist : parseEmailList(env.STUDIO_OWNER_EMAILS);
  const requireAccount = accountFlag || allowedEmails.size > 0;
  const keyConfigured = Boolean((env.OPENAI_API_KEY || '').trim());
  let mode: AiAccessPolicyMode;
  if (token) mode = 'token';
  else if (allowedEmails.size > 0) mode = 'allowlist';
  else if (accountFlag) mode = 'any-account';
  else if (env.OPENAI_ALLOW_ANONYMOUS === 'true') mode = 'anonymous';
  else mode = keyConfigured ? 'locked' : 'not-configured';
  return { mode, allowedEmails, token, requireAccount };
}
