import type { ChatMessage, ExternalChatPlatform, ExternalChatStatusPayload } from '@studio/shared';

export interface ExternalChatPlatformMetrics {
  platform: ExternalChatPlatform;
  importedCount: number;
  importedLabel: string;
  activityLabel: string;
  nextPollLabel: string;
  statusLabel: string;
}

function parseTimeMs(value: string | undefined): number | null {
  if (!value) return null;
  const timeMs = Date.parse(value);
  return Number.isFinite(timeMs) ? timeMs : null;
}

function formatUnit(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

export function formatRelativeTime(value: string | undefined, nowMs = Date.now()): string {
  const timeMs = parseTimeMs(value);
  if (timeMs === null) return '';

  const diffMs = timeMs - nowMs;
  const absMs = Math.abs(diffMs);
  if (absMs < 30_000) return 'just now';

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const count = absMs >= day
    ? Math.round(absMs / day)
    : absMs >= hour
      ? Math.round(absMs / hour)
      : Math.round(absMs / minute);
  const unit = absMs >= day ? 'day' : absMs >= hour ? 'hr' : 'min';
  const label = formatUnit(Math.max(1, count), unit);
  return diffMs > 0 ? `in ${label}` : `${label} ago`;
}

function getMessageImportTimeMs(message: ChatMessage): number {
  return parseTimeMs(message.source?.publishedAt) ?? parseTimeMs(message.timestamp) ?? 0;
}

function getImportedMessages(
  messages: readonly ChatMessage[],
  platform: ExternalChatPlatform
): ChatMessage[] {
  return messages.filter((message) => (
    !message.isBackstage &&
    !message.recipientId &&
    message.source?.platform === platform
  ));
}

export function getExternalChatPlatformMetrics(
  messages: readonly ChatMessage[],
  platform: ExternalChatPlatform,
  status: ExternalChatStatusPayload | null | undefined,
  nowMs = Date.now()
): ExternalChatPlatformMetrics {
  const importedMessages = getImportedMessages(messages, platform);
  const latestImportMs = importedMessages.reduce((latestMs, message) => {
    return Math.max(latestMs, getMessageImportTimeMs(message));
  }, 0);
  const latestImportLabel = latestImportMs > 0
    ? formatRelativeTime(new Date(latestImportMs).toISOString(), nowMs)
    : '';
  const nextPollLabel = formatRelativeTime(status?.nextPollAt, nowMs);

  return {
    platform,
    importedCount: importedMessages.length,
    importedLabel: `${importedMessages.length} imported`,
    activityLabel: latestImportLabel
      ? `Last import ${latestImportLabel}`
      : status?.status === 'error'
        ? 'Needs attention'
        : status?.status === 'connecting'
          ? 'Waiting for first import'
          : 'Waiting for comments',
    nextPollLabel: nextPollLabel ? `Next poll ${nextPollLabel}` : '',
    statusLabel: status?.status || (importedMessages.length > 0 ? 'connected' : 'idle'),
  };
}
