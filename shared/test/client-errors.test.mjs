import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sanitizeClientErrorMessage as message,
  sanitizeClientErrorPage as page,
  sanitizeClientErrorRelease as release,
  sanitizeClientErrorStack as stack,
} from '../dist/index.js';

test('error messages use only reviewed vocabulary, including non-email names and secrets', () => {
  for (const text of ['John Smith joined', 'camera "Jane Jones" failed', 'Failed /Users/alice/sermon.mp4', 'token=abc password=xyz', '{"email":"person@example.com"}', 'https://media.test/private-id?token=abc']) {
    assert.equal(message(text), 'Error: details omitted');
  }
  assert.equal(message('TypeError: Failed to fetch https://user:password@host/private'), 'Network request failed');
  assert.equal(message('TypeError: Cannot read properties of undefined (reading "Jane")'), 'Cannot access an undefined or null value');
  assert.equal(message('Minified React error #310; visit https://react.dev/errors/310?args=secret'), 'React error #310');
  assert.equal(message('Live relay stopped after 3 reconnect attempt(s): token=secret'), 'Live relay stopped after reconnect attempts');
  assert.equal(message('A local recording track (private-device) was interrupted.'), 'Local recording track interrupted');
  assert.equal(message('  '), null);
});

test('stack retains only bundle hash and coordinates, never source paths or identifiers', () => {
  const input = 'Error: private name\n at privateName (https://host/assets/StudioRoom-ABcd_123.js:44:12)\n at https://host/studio/private-room:1:9\n at file:///Users/name/source.ts:1:2\n at chrome-extension://secret/a.js:1:2';
  assert.equal(stack(input), 'asset:ABcd_123:44:12');
  assert.equal(stack(stack(input)), stack(input), 'safe format survives the server boundary');
  assert.equal(stack('asset:ABcd_123:44:12\n'.repeat(100)).split('\n').length, 12);
  assert.equal(stack('https://host/assets/app-ABcd_123.js?token=secret:1:2'), undefined);
});

test('route templates and commit-only releases omit account, room, and watch identities', () => {
  assert.equal(page('https://host/studio/private-room?token=secret'), '/studio/:roomId');
  assert.equal(page('/studio/private-room/popout-chat'), '/studio/:roomId/popout-chat');
  assert.equal(page('/join/secret#password'), '/join/:roomId');
  assert.equal(page('/watch/private-person'), '/watch/:roomId');
  assert.equal(page('/users/AliceSmith'), '/other');
  assert.equal(page('/reset-password?token=secret'), '/reset-password');
  assert.equal(page('/'), '/');
  assert.equal(release('A12b3C4'), 'a12b3c4');
  for (const value of ['person@example.com', 'secret', '123456', 'a'.repeat(41), undefined]) assert.equal(release(value), undefined);
});

test('sanitization is idempotent for every supported diagnostic type', () => {
  for (const text of ['QuotaExceededError: private detail', 'TypeError: private detail', 'Browser MediaRecorder failed during the live relay.', 'Minified React error #310', 'NotAllowedError: private camera']) {
    assert.equal(message(message(text)), message(text));
  }
  for (const path of ['/studio/private', '/join/private', '/watch/private', '/other']) assert.equal(page(page(path)), page(path));
});
