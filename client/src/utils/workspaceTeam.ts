export const WORKSPACE_TEAM_STORAGE_KEY = 'livestream_studio_workspace_team_v1';

export type WorkspaceTeamRole = 'owner' | 'producer' | 'editor' | 'guest-manager';

export interface SavedWorkspaceTeamMember {
  id: string;
  name: string;
  email: string;
  role: WorkspaceTeamRole;
  createdAt: string;
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
