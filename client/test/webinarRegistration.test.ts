import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RoomRegistrantListResponse } from '@studio/shared';
import {
  buildRegistrantsCsv,
  getRegistrationSessionKey,
  isValidRegistrantEmail,
} from '../src/utils/webinarRegistration.ts';

describe('webinar registration helpers', () => {
  it('validates guest registration emails before submitting', () => {
    assert.equal(isValidRegistrantEmail('viewer@example.com'), true);
    assert.equal(isValidRegistrantEmail(' viewer@example.com '), true);
    assert.equal(isValidRegistrantEmail('viewer@example'), false);
    assert.equal(isValidRegistrantEmail('viewer @example.com'), false);
  });

  it('creates stable per-room session storage keys', () => {
    assert.equal(getRegistrationSessionKey('room-123'), 'roomRegistrant:room-123');
  });

  it('exports registrants as quoted spreadsheet-safe CSV', () => {
    const data: RoomRegistrantListResponse = {
      roomId: 'room-123',
      exportedAt: '2026-07-02T01:00:00.000Z',
      registrants: [
        {
          id: 'reg-1',
          roomId: 'room-123',
          name: 'Jane "Viewer"',
          email: '=cmd@example.com',
          registeredAt: '2026-07-02T01:01:00.000Z',
        },
      ],
    };

    assert.equal(
      buildRegistrantsCsv(data, 'Launch Show'),
      [
        '"Studio","Registrant name","Email","Registered at"',
        '"Launch Show","Jane ""Viewer""","\'=cmd@example.com","2026-07-02T01:01:00.000Z"',
        '',
      ].join('\n')
    );
  });
});
