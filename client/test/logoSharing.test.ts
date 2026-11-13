import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { MAX_INLINE_BRANDING_DATA_URL_LENGTH, SIGNALING_MAX_PAYLOAD_BYTES, SIGNALING_SAFE_MESSAGE_BYTES } from '@studio/shared';
import { buildStudioBrandingPayload, DEFAULT_WAITING_ROOM_BRANDING } from '../src/utils/waitingRoomBranding.ts';
import { createSignalingSendGuard, measureEncodedBytes } from '../src/utils/signalingSendGuard.ts';
import { encodeLogoWithinLimit, LogoPrepareError, planLogoScale } from '../src/utils/logoImage.ts';
import {
  createPictureUploadCache,
  PermanentUploadError,
  runWithRetry,
  UploadTimeoutError,
} from '../src/utils/pictureUpload.ts';
import { needsLogoUpload, resolveSharedLogo, toSharedLogo, uploadLogo } from '../src/utils/logoSync.ts';

const NONE = { type: 'none' as const, value: '' };
const bigDataUrl = `data:image/png;base64,${'A'.repeat(200_000)}`;
const tinyDataUrl = `data:image/png;base64,${'A'.repeat(500)}`;
const brandingInput = (logoUrl: string | null, logoImageId?: string | null) => ({
  brandColor: '#a78bfa',
  logoUrl,
  logoImageId,
  stageBackground: NONE,
  waitingRoom: DEFAULT_WAITING_ROOM_BRANDING,
});

describe('studio branding payload with a logo', () => {
  it('never carries a data: URL above the small cap, nor a blob: URL', () => {
    assert.equal(buildStudioBrandingPayload(brandingInput(bigDataUrl)).logoUrl, null);
    assert.equal(buildStudioBrandingPayload(brandingInput('blob:http://localhost/1')).logoUrl, null);
    const justOver = `data:image/png;base64,${'A'.repeat(MAX_INLINE_BRANDING_DATA_URL_LENGTH)}`;
    assert.equal(buildStudioBrandingPayload(brandingInput(justOver)).logoUrl, null);
  });

  it('keeps a tiny inline logo and an https logo as they are', () => {
    assert.equal(buildStudioBrandingPayload(brandingInput(tinyDataUrl)).logoUrl, tinyDataUrl);
    assert.equal(buildStudioBrandingPayload(brandingInput('https://cdn.example.test/logo.png')).logoUrl, 'https://cdn.example.test/logo.png');
  });

  it('names an uploaded logo by id and stays far below the signaling cap', () => {
    const payload = buildStudioBrandingPayload(brandingInput(bigDataUrl, 'logo-1'));
    assert.equal(payload.logoUrl, null);
    assert.equal(payload.logoImageId, 'logo-1');
    const bytes = measureEncodedBytes(JSON.stringify({ type: 'studio-branding-updated', payload }));
    assert.ok(bytes < 2048, `${bytes} bytes`);
  });

  it('keeps the rest of the branding when the picture is missing', () => {
    const payload = buildStudioBrandingPayload({ ...brandingInput(bigDataUrl), brandColor: '#112233' });
    assert.equal(payload.brandColor, '#112233');
    assert.equal(payload.waitingRoom.headline, DEFAULT_WAITING_ROOM_BRANDING.headline);
  });
});

describe('logo sharing helpers', () => {
  it('uploads only logos another browser cannot open', () => {
    assert.equal(needsLogoUpload(bigDataUrl), true);
    assert.equal(needsLogoUpload('blob:http://localhost/1'), true);
    assert.equal(needsLogoUpload('https://cdn.example.test/logo.png'), false);
    assert.equal(needsLogoUpload(null), false);
  });

  it('shares an uploaded logo by id and never inline', () => {
    assert.deepEqual(toSharedLogo(bigDataUrl, 'id-1'), { logoUrl: null, logoImageId: 'id-1' });
    assert.deepEqual(toSharedLogo(bigDataUrl), { logoUrl: null });
    assert.deepEqual(toSharedLogo('https://cdn.example.test/logo.png', 'ignored'), { logoUrl: 'https://cdn.example.test/logo.png' });
    assert.deepEqual(toSharedLogo(null), { logoUrl: null });
  });

  it('paints the loaded picture for an id, the address for https, and nothing for an unloaded id', () => {
    const base = { brandColor: '#a78bfa', logoUrl: null, stageBackground: NONE, waitingRoom: DEFAULT_WAITING_ROOM_BRANDING };
    assert.equal(resolveSharedLogo({ ...base, logoImageId: 'a' }, 'blob:x'), 'blob:x');
    assert.equal(resolveSharedLogo({ ...base, logoImageId: 'a' }, null), null);
    assert.equal(resolveSharedLogo({ ...base, logoUrl: 'https://cdn.example.test/l.png' }, null), 'https://cdn.example.test/l.png');
    assert.equal(resolveSharedLogo({ ...base, logoUrl: 'javascript:alert(1)' }, null), null);
    assert.equal(resolveSharedLogo(null, 'blob:x'), null);
  });
});

describe('signaling send guard', () => {
  it('measures bytes, not characters', () => {
    assert.equal(measureEncodedBytes('abc'), 3);
    assert.equal(measureEncodedBytes('é'), 2);
    assert.equal(measureEncodedBytes('日本'), 6);
    assert.equal(measureEncodedBytes('😀'), 4);
  });

  it('keeps a safe limit below the server cap', () => {
    assert.ok(SIGNALING_SAFE_MESSAGE_BYTES < SIGNALING_MAX_PAYLOAD_BYTES);
  });

  it('refuses a message whose characters fit but whose bytes do not', () => {
    const guard = createSignalingSendGuard({ limitBytes: 1000 });
    const fewChars = { type: 'chat', text: '日'.repeat(400) }; // ~420 characters, ~1220 bytes
    assert.ok(JSON.stringify(fewChars).length < 1000);
    assert.equal(guard.encode(fewChars), null);
    assert.equal(guard.encode({ type: 'chat', text: 'x'.repeat(400) }) !== null, true);
  });

  it('refuses messages above the real safe limit and reports once per type', () => {
    const reports: Array<[string, number, number]> = [];
    const guard = createSignalingSendGuard({ report: (type, bytes, limit) => reports.push([type, bytes, limit]) });
    const huge = { type: 'studio-branding-updated', payload: 'A'.repeat(SIGNALING_SAFE_MESSAGE_BYTES) };
    assert.equal(guard.encode(huge), null);
    assert.equal(guard.encode(huge), null);
    assert.equal(guard.encode({ type: 'other', payload: 'A'.repeat(SIGNALING_SAFE_MESSAGE_BYTES) }), null);
    assert.deepEqual(reports.map((r) => r[0]), ['studio-branding-updated', 'other']);
    assert.equal(reports[0][2], SIGNALING_SAFE_MESSAGE_BYTES);
    const small = { type: 'ping' };
    assert.equal(guard.encode(small), JSON.stringify(small));
  });
});

describe('logo scale-down decision', () => {
  const png = (width: number, height: number, bytes: number, type = 'image/png') => ({ width, height, bytes, type });

  it('keeps a small file that already fits', () => {
    assert.deepEqual(planLogoScale(png(205, 205, 146_749)), { action: 'keep' });
    assert.deepEqual(planLogoScale(png(1024, 600, 100_000)), { action: 'keep' });
  });

  it('scales the long edge to 1024 without upscaling and keeps the aspect ratio', () => {
    assert.deepEqual(planLogoScale(png(2400, 1600, 1_500_000)), { action: 'scale', width: 1024, height: 683 });
    assert.deepEqual(planLogoScale(png(1000, 3000, 50_000)), { action: 'scale', width: 341, height: 1024 });
  });

  it('re-encodes a picture that is small in pixels but heavy in bytes, or in a format the store refuses', () => {
    assert.deepEqual(planLogoScale(png(800, 600, 5_000_000)), { action: 'scale', width: 800, height: 600 });
    assert.deepEqual(planLogoScale(png(300, 300, 4000, 'image/gif')), { action: 'scale', width: 300, height: 300 });
    assert.deepEqual(planLogoScale(png(300, 300, 4000, 'image/svg+xml')), { action: 'scale', width: 300, height: 300 });
  });

  it('refuses an image without a usable size', () => {
    assert.throws(() => planLogoScale(png(0, 0, 100)), LogoPrepareError);
  });

  it('shrinks until the encoding fits the store, and gives up with null when it never does', async () => {
    const sizes: number[] = [];
    const fits = await encodeLogoWithinLimit({ width: 1024, height: 1024 }, async (width) => {
      sizes.push(width);
      return new Blob([new Uint8Array(width < 700 ? 1000 : 900_000)]);
    }, 768 * 1024);
    assert.ok(fits && fits.size === 1000);
    assert.ok(sizes[sizes.length - 1] < 700);
    const never = await encodeLogoWithinLimit({ width: 1024, height: 1024 }, async () => new Blob([new Uint8Array(900_000)]), 768 * 1024);
    assert.equal(never, null);
  });
});

describe('picture upload retries', () => {
  it('times out an attempt, retries up to 3 times with a growing pause, then fails', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const pauses: number[] = [];
      let calls = 0;
      const result = runWithRetry(() => { calls += 1; return new Promise<string>(() => {}); }, {
        attemptTimeoutMs: 5000,
        sleep: async (ms) => { pauses.push(ms); },
      }).catch((error) => error);
      // Each attempt hangs until its 5 s limit.
      for (let i = 0; i < 3; i += 1) {
        await Promise.resolve();
        await Promise.resolve();
        mock.timers.tick(5000);
        await Promise.resolve();
        await Promise.resolve();
      }
      const error = await result;
      assert.ok(error instanceof UploadTimeoutError, String(error));
      assert.equal(calls, 3);
      assert.deepEqual(pauses, [1000, 2000]);
    } finally {
      mock.timers.reset();
    }
  });

  it('aborts the request of a timed-out attempt', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let seen: AbortSignal | undefined;
      const result = runWithRetry((signal) => { seen = signal; return new Promise<string>(() => {}); }, {
        attemptTimeoutMs: 1000,
        maxAttempts: 1,
      }).catch((error) => error);
      await Promise.resolve();
      mock.timers.tick(1000);
      assert.ok((await result) instanceof UploadTimeoutError);
      assert.equal(seen?.aborted, true);
    } finally {
      mock.timers.reset();
    }
  });

  it('succeeds on a later attempt and reports each failure', async () => {
    let calls = 0;
    const failures: number[] = [];
    const id = await runWithRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error('network');
      return 'img-1';
    }, { sleep: async () => {}, onAttemptFailed: (_e, attempt) => failures.push(attempt) });
    assert.equal(id, 'img-1');
    assert.deepEqual(failures, [1, 2]);
  });

  it('does not repeat an upload that can never succeed', async () => {
    let calls = 0;
    await assert.rejects(runWithRetry(async () => {
      calls += 1;
      throw new PermanentUploadError('too large', 413);
    }, { sleep: async () => {} }), PermanentUploadError);
    assert.equal(calls, 1);
  });

  it('uploads one picture once however often it is asked for, and forgets failures', async () => {
    const cache = createPictureUploadCache();
    let starts = 0;
    const start = async () => { starts += 1; return 'id-a'; };
    const [first, second] = await Promise.all([cache.upload('k', start), cache.upload('k', start)]);
    assert.deepEqual([first, second], ['id-a', 'id-a']);
    assert.equal(await cache.upload('k', start), 'id-a');
    assert.equal(starts, 1);
    assert.equal(cache.get('k'), 'id-a');

    await assert.rejects(cache.upload('bad', async () => { throw new Error('down'); }));
    assert.equal(cache.get('bad'), undefined);
    assert.equal(await cache.upload('bad', async () => 'id-b'), 'id-b');

    cache.clear();
    assert.equal(cache.get('k'), undefined);
    assert.equal(await cache.upload('k', start), 'id-a');
    assert.equal(starts, 2);
  });
});

describe('logo upload with a fake fetch', () => {
  const auth = { roomId: 'room-1', participantId: 'host-1', token: 'tok' };
  const picture = new Blob([new Uint8Array(1000)], { type: 'image/png' });

  it('posts the prepared logo with the logo kind header and returns its id', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ imageId: 'logo-9' }), { status: 200 });
    }) as unknown as typeof fetch;
    const id = await uploadLogo('data:image/png;base64,AAAA', auth, { fetchImpl, prepare: async () => picture });
    assert.equal(id, 'logo-9');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/rooms\/room-1\/stage-images$/);
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['x-stage-image-kind'], 'logo');
    assert.equal(headers['X-Stage-Token'], 'tok');
  });

  it('retries a server error and stops at once on a refusal', async () => {
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      return calls < 2 ? new Response('', { status: 503 }) : new Response(JSON.stringify({ imageId: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch;
    assert.equal(await uploadLogo('x', auth, { fetchImpl: flaky, prepare: async () => picture, retry: { sleep: async () => {} } }), 'ok');
    assert.equal(calls, 2);

    let refused = 0;
    const tooLarge = (async () => { refused += 1; return new Response('', { status: 413 }); }) as unknown as typeof fetch;
    await assert.rejects(uploadLogo('x', auth, { fetchImpl: tooLarge, prepare: async () => picture, retry: { sleep: async () => {} } }), PermanentUploadError);
    assert.equal(refused, 1);
  });
});
