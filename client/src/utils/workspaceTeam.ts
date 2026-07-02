export const WORKSPACE_TEAM_STORAGE_KEY = 'livestream_studio_workspace_team_v1';

export type WorkspaceTeamRole = 'owner' | 'producer' | 'editor' | 'guest-manager';

export interface SavedWorkspaceTeamMember {
  id: string;
  name: string;
  email: string;
  role: WorkspaceTeamRole;
  createdAt: string;
}

export interface WorkspaceTeamStudioInviteInput {
  roomName: string;
  hostName?: string | null;
  guestInviteUrl: string;
  hostEntryUrl: string;
  scheduledLabel?: string | null;
  passwordProtected?: boolean;
  members: SavedWorkspaceTeamMember[];
}

const MAX_TEAM_MEMBERS = 12;
const TEAM_ROLE_LABELS: Record<WorkspaceTeamRole, string> = {
  owner: 'Owner',
  producer: 'Producer',
  editor: 'Editor',
  'guest-manager': 'Guest Manager',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function safeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, maxLength);
}

function safeEmail(value: unknown): string {
  const email = safeText(value, 160).toLowerCase();
  if (!email) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function safeRole(value: unknown): WorkspaceTeamRole {
  return value === 'owner' || value === 'producer' || value === 'editor' || value === 'guest-manager'
    ? value
    : 'producer';
}

function safeIsoDate(value: unknown, fallback = new Date().toISOString()): string {
  const timestamp = Date.parse(safeText(value, 64));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function makeTeamMemberId(name: string, email: string, createdAt: string): string {
  const seed = `${name}-${email || createdAt}`.toLowerCase();
  return `member-${seed.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'team'}`;
}

export function normalizeWorkspaceTeamMember(value: unknown): SavedWorkspaceTeamMember | null {
  if (!isRecord(value)) return null;
  const name = safeText(value.name, 80);
  if (!name) return null;
  const email = safeEmail(value.email);
  const createdAt = safeIsoDate(value.createdAt);
  const id = safeText(value.id, 96) || makeTeamMemberId(name, email, createdAt);
  return {
    id,
    name,
    email,
    role: safeRole(value.role),
    createdAt,
  };
}

export function parseSavedWorkspaceTeamMembers(value: string | null): SavedWorkspaceTeamMember[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return normalizeWorkspaceTeamMembers(parsed);
  } catch {
    return [];
  }
}

export function normalizeWorkspaceTeamMembers(values: unknown): SavedWorkspaceTeamMember[] {
  if (!Array.isArray(values)) return [];
  const byId = new Map<string, SavedWorkspaceTeamMember>();
  for (const value of values) {
    const member = normalizeWorkspaceTeamMember(value);
    if (member) byId.set(member.id, member);
  }
  return Array.from(byId.values())
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.name.localeCompare(b.name))
    .slice(0, MAX_TEAM_MEMBERS);
}

export function serializeWorkspaceTeamMembers(members: SavedWorkspaceTeamMember[]): string {
  return JSON.stringify(normalizeWorkspaceTeamMembers(members));
}

export function createWorkspaceTeamMember(input: {
  name: string;
  email?: string;
  role?: WorkspaceTeamRole;
  id?: string;
  createdAt?: string;
}): SavedWorkspaceTeamMember | null {
  return normalizeWorkspaceTeamMember({
    id: input.id,
    name: input.name,
    email: input.email || '',
    role: input.role || 'producer',
    createdAt: input.createdAt || new Date().toISOString(),
  });
}

export function upsertWorkspaceTeamMember(
  members: SavedWorkspaceTeamMember[],
  member: SavedWorkspaceTeamMember
): SavedWorkspaceTeamMember[] {
  return normalizeWorkspaceTeamMembers([
    ...members.filter((item) => item.id !== member.id),
    member,
  ]);
}

export function removeWorkspaceTeamMember(
  members: SavedWorkspaceTeamMember[],
  memberId: string
): SavedWorkspaceTeamMember[] {
  return normalizeWorkspaceTeamMembers(members.filter((member) => member.id !== memberId));
}

export function getWorkspaceTeamRoleLabel(role: WorkspaceTeamRole): string {
  return TEAM_ROLE_LABELS[role] || TEAM_ROLE_LABELS.producer;
}

export function canUseWorkspaceOperatorLink(role: WorkspaceTeamRole): boolean {
  return role === 'owner' || role === 'producer';
}

function normalizeInviteText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);
}

function normalizeInviteUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

export function buildWorkspaceTeamStudioInviteDetails(input: WorkspaceTeamStudioInviteInput): string {
  const roomName = normalizeInviteText(input.roomName, 100) || 'Studio';
  const hostName = normalizeInviteText(input.hostName, 80);
  const scheduledLabel = normalizeInviteText(input.scheduledLabel, 120);
  const guestInviteUrl = normalizeInviteUrl(input.guestInviteUrl);
  const hostEntryUrl = normalizeInviteUrl(input.hostEntryUrl);
  const members = normalizeWorkspaceTeamMembers(input.members);
  const inviteLines = members.map((member) => {
    const roleLabel = getWorkspaceTeamRoleLabel(member.role);
    const inviteUrl = canUseWorkspaceOperatorLink(member.role) && hostEntryUrl ? hostEntryUrl : guestInviteUrl;
    return `${member.name} (${roleLabel}): ${inviteUrl}`;
  });

  return [
    `Production team invite: ${roomName}`,
    hostName ? `Host: ${hostName}` : null,
    scheduledLabel ? `Time: ${scheduledLabel}` : null,
    input.passwordProtected ? 'Guest entry is password protected. Ask the host for the password if needed.' : null,
    '',
    'Access links:',
    ...inviteLines,
    '',
    hostEntryUrl && members.some((member) => canUseWorkspaceOperatorLink(member.role))
      ? 'Owner and Producer links include private operator access. Keep them inside the production team.'
      : null,
  ].filter((line) => line !== null).join('\n').trim();
}

export function buildWorkspaceTeamStudioInviteEmailHref(input: WorkspaceTeamStudioInviteInput): string {
  const members = normalizeWorkspaceTeamMembers(input.members);
  const recipients = members
    .map((member) => member.email)
    .filter(Boolean)
    .filter((email, index, values) => values.indexOf(email) === index)
    .map((email) => encodeURIComponent(email))
    .join(',');
  const roomName = normalizeInviteText(input.roomName, 100) || 'Studio';
  const subject = encodeURIComponent(`Production team invite: ${roomName}`);
  const body = encodeURIComponent(buildWorkspaceTeamStudioInviteDetails(input));

  return `mailto:${recipients}?subject=${subject}&body=${body}`;
}
