import type { StreamDestination } from '@studio/shared';
import {
  getEnabledDestinationPreflightIssue,
  getEnabledDestinations,
  MAX_ENABLED_DESTINATIONS,
} from './streamDestinations.ts';

export type LivePreflightStatus = 'good' | 'warning' | 'bad';

export interface LivePreflightHealthCheck {
  id: string;
  label: string;
  status: LivePreflightStatus;
  detail: string;
}

export interface LivePreflightSessionHealth {
  checks: LivePreflightHealthCheck[];
}

export interface LivePreflightRelayReadiness {
  status: 'checking' | 'ready' | 'unavailable';
  message: string;
}

export interface LivePreflightOptions {
  destinations: StreamDestination[];
  relayReadiness?: LivePreflightRelayReadiness;
  sessionHealth?: LivePreflightSessionHealth;
  sceneCount: number;
  outputSummary: string;
}

export interface LivePreflightItem {
  id: string;
  label: string;
  status: LivePreflightStatus;
  detail: string;
  blocksStart: boolean;
}

export interface LivePreflightChecklist {
  status: LivePreflightStatus;
  label: string;
  items: LivePreflightItem[];
  blockingIssue: string | null;
  warningCount: number;
  blockedCount: number;
}

function findHealthCheck(sessionHealth: LivePreflightSessionHealth | undefined, id: string): LivePreflightHealthCheck | null {
  return sessionHealth?.checks.find((check) => check.id === id) || null;
}

function getWorstStatus(statuses: LivePreflightStatus[]): LivePreflightStatus {
  if (statuses.includes('bad')) return 'bad';
  if (statuses.includes('warning')) return 'warning';
  return 'good';
}

function getChecklistStatus(items: LivePreflightItem[]): LivePreflightStatus {
  if (items.some((item) => item.blocksStart && item.status === 'bad')) return 'bad';
  if (items.some((item) => item.status !== 'good')) return 'warning';
  return 'good';
}

function labelFromStatus(status: LivePreflightStatus): string {
  switch (status) {
    case 'good': return 'Ready to start';
    case 'warning': return 'Review before live';
    case 'bad': return 'Blocked';
  }
}

function buildDestinationItem(destinations: StreamDestination[]): LivePreflightItem {
  const enabledDestinations = getEnabledDestinations(destinations);
  const issue = getEnabledDestinationPreflightIssue(destinations, null);
  return {
    id: 'destinations',
    label: 'Destinations',
    status: issue ? 'bad' : 'good',
    detail: issue || `${enabledDestinations.length}/${MAX_ENABLED_DESTINATIONS} destination${enabledDestinations.length === 1 ? '' : 's'} enabled and validated.`,
    blocksStart: true,
  };
}

function buildRelayItem(readiness: LivePreflightRelayReadiness | undefined): LivePreflightItem {
  if (!readiness) {
    return {
      id: 'media-relay',
      label: 'Media relay',
      status: 'bad',
      detail: 'Media relay readiness has not been checked.',
      blocksStart: true,
    };
  }
  return {
    id: 'media-relay',
    label: 'Media relay',
    status: readiness.status === 'ready' ? 'good' : 'bad',
    detail: readiness.message,
    blocksStart: true,
  };
}

function buildEncodingItem(sessionHealth: LivePreflightSessionHealth | undefined): LivePreflightItem {
  const encoding = findHealthCheck(sessionHealth, 'encoding');
  return {
    id: 'encoding',
    label: 'Browser encoder',
    status: encoding?.status || 'warning',
    detail: encoding?.detail || 'Browser WebM encoder readiness has not been checked.',
    blocksStart: encoding?.status === 'bad',
  };
}

function buildHealthItem(
  id: string,
  label: string,
  healthCheck: LivePreflightHealthCheck | null,
  fallbackDetail: string
): LivePreflightItem {
  return {
    id,
    label,
    status: healthCheck?.status || 'warning',
    detail: healthCheck?.detail || fallbackDetail,
    blocksStart: true,
  };
}

function buildMediaItem(sessionHealth: LivePreflightSessionHealth | undefined): LivePreflightItem {
  const audio = findHealthCheck(sessionHealth, 'audio');
  const video = findHealthCheck(sessionHealth, 'video');
  const rawStatus = getWorstStatus([audio?.status || 'warning', video?.status || 'warning']);
  const status: LivePreflightStatus = rawStatus === 'bad' ? 'warning' : rawStatus;
  const detail = [
    audio ? `Mic: ${audio.detail}` : 'Mic: not checked.',
    video ? `Camera: ${video.detail}` : 'Camera: not checked.',
  ].join(' ');

  return {
    id: 'media',
    label: 'Camera and microphone',
    status,
    detail,
    blocksStart: false,
  };
}

export function buildLivePreflightChecklist(options: LivePreflightOptions): LivePreflightChecklist {
  const signaling = findHealthCheck(options.sessionHealth, 'signaling');
  const network = findHealthCheck(options.sessionHealth, 'network');
  const storage = findHealthCheck(options.sessionHealth, 'storage');

  const items: LivePreflightItem[] = [
    buildDestinationItem(options.destinations),
    buildRelayItem(options.relayReadiness),
    buildEncodingItem(options.sessionHealth),
    buildHealthItem('studio-connection', 'Studio connection', signaling, 'Studio connection has not been checked.'),
    buildHealthItem('network', 'Network', network, 'Network status has not been checked.'),
    buildMediaItem(options.sessionHealth),
    {
      id: 'scenes',
      label: 'Saved scenes',
      status: options.sceneCount > 0 ? 'good' : 'warning',
      detail: options.sceneCount > 0
        ? `${options.sceneCount} saved scene${options.sceneCount === 1 ? '' : 's'} available for switching.`
        : 'No saved scenes yet. Save at least one scene for smoother live production.',
      blocksStart: false,
    },
    {
      id: 'output',
      label: 'Output format',
      status: 'good',
      detail: options.outputSummary,
      blocksStart: false,
    },
    {
      id: 'storage',
      label: 'Recording storage',
      status: storage?.status || 'warning',
      detail: storage?.detail || 'Browser recording storage has not been checked.',
      blocksStart: false,
    },
  ];

  const blockingIssue = items.find((item) => item.blocksStart && item.status === 'bad')?.detail || null;
  const warningCount = items.filter((item) => item.status === 'warning').length;
  const blockedCount = items.filter((item) => item.status === 'bad').length;
  const status = getChecklistStatus(items);

  return {
    status,
    label: labelFromStatus(status),
    items,
    blockingIssue,
    warningCount,
    blockedCount,
  };
}
