import type { RoomRegistrantListResponse } from '@studio/shared';

export const GUEST_REGISTRATION_EMAIL_STORAGE_KEY = 'livestream-studio:guest-email';

const REGISTRATION_SESSION_STORAGE_PREFIX = 'roomRegistrant';

export function getRegistrationSessionKey(roomId: string): string {
  return `${REGISTRATION_SESSION_STORAGE_PREFIX}:${roomId}`;
}

export function isValidRegistrantEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function makeCsvCellSafe(value: string): string {
  const cleaned = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return /^[=+\-@]/.test(cleaned.trimStart()) ? `'${cleaned}` : cleaned;
}

function escapeCsvCell(value: string): string {
  return `"${makeCsvCellSafe(value).replace(/"/g, '""')}"`;
}

export function buildRegistrantsCsv(data: RoomRegistrantListResponse, roomName: string): string {
  const rows = [
    ['Studio', 'Registrant name', 'Email', 'Registered at'],
    ...data.registrants.map((registrant) => [
      roomName,
      registrant.name,
      registrant.email,
      registrant.registeredAt,
    ]),
  ];
  return `${rows.map((row) => row.map(escapeCsvCell).join(',')).join('\n')}\n`;
}
