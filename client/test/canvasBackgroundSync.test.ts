import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StageBackground } from '@studio/shared';
import {
  getCanvasBackgroundUploadKey,
  getSharedBackgroundImageUrl,
  needsCanvasBackgroundUpload,
  resolveSharedStageBackground,
  toSharedStageBackground,
  uploadCanvasBackground,
} from '../src/utils/canvasBackgroundSync.ts';
import { CANVAS_BACKGROUND_MAX_BYTES } from '../src/utils/canvasBackgroundImage.ts';
import { DEFAULT_PROGRAM_BACKGROUND, drawStageBackground } from '../src/utils/compositorBackground.ts';
import { buildStudioBrandingPayload, DEFAULT_WAITING_ROOM_BRANDING } from '../src/utils/waitingRoomBranding.ts';

const NONE: StageBackground = { type: 'none', value: '' };
const webpDataUrl = `data:image/webp;base64,${'A'.repeat(500_000)}`;

describe('canvas background sharing', () => {
  it('uploads only pictures another browser cannot open', () => {
    assert.equal(needsCanvasBackgroundUpload({ type: 'image', value: webpDataUrl }), true);
    assert.equal(needsCanvasBackgroundUpload({ type: 'image', value: 'blob:http://localhost/1' }), true);
    assert.equal(needsCanvasBackgroundUpload({ type: 'image', value: 'https://cdn.example.test/bg.jpg' }), false);
    assert.equal(needsCanvasBackgroundUpload({ type: 'color', value: '#123456' }), false);
    assert.equal(needsCanvasBackgroundUpload({ type: 'video', value: 'blob:http://localhost/2' }), false);
  });

  it('keeps the branding message far below the 64 KiB signaling cap for a large picture', () => {
    const shared = toSharedStageBackground({ type: 'image', value: webpDataUrl }, 'img-123');
    assert.deepEqual(shared, { type: 'image', value: '', imageId: 'img-123' });
    const payload = buildStudioBrandingPayload({
      brandColor: '#a78bfa',
      logoUrl: null,
      stageBackground: shared,
      waitingRoom: DEFAULT_WAITING_ROOM_BRANDING,
      updatedBy: 'host-1',
    });
    assert.deepEqual(payload.stageBackground, shared);
    const message = JSON.stringify({ type: 'studio-branding-updated', payload });
    assert.ok(message.length < 2048, `branding message is ${message.length} bytes`);
    assert.ok(!message.includes('base64'));
  });

  it('never sends an unuploaded picture, a session video or a stale id', () => {
    assert.deepEqual(toSharedStageBackground({ type: 'image', value: webpDataUrl }), NONE);
    assert.deepEqual(toSharedStageBackground({ type: 'video', value: 'blob:http://localhost/2' }), NONE);
    assert.deepEqual(toSharedStageBackground({ type: 'color', value: '#123456', imageId: 'old' }), { type: 'color', value: '#123456' });
    assert.deepEqual(toSharedStageBackground({ type: 'none', value: 'junk' }), NONE);
    assert.deepEqual(
      toSharedStageBackground({ type: 'gradient', value: 'linear-gradient(#000, #fff)' }),
      { type: 'gradient', value: 'linear-gradient(#000, #fff)' },
    );
  });

  it('keys uploads by content without holding the whole data URL', () => {
    const key = getCanvasBackgroundUploadKey({ type: 'image', value: webpDataUrl });
    assert.ok(key.length < 200);
    assert.notEqual(key, getCanvasBackgroundUploadKey({ type: 'image', value: `${webpDataUrl}B` }));
  });

  it('loads a shared picture from the studio stage-image route', () => {
    assert.equal(
      getSharedBackgroundImageUrl({ type: 'image', value: '', imageId: 'a/b' }, 'room 1'),
      '/api/rooms/room%201/stage-images/a%2Fb',
    );
    assert.equal(getSharedBackgroundImageUrl({ type: 'color', value: '#123456' }, 'room'), null);
    assert.equal(getSharedBackgroundImageUrl(null, 'room'), null);
  });

  it('paints the loaded picture, colours as sent, and the default for anything unloadable', () => {
    const shared: StageBackground = { type: 'image', value: '', imageId: 'img-1' };
    assert.deepEqual(resolveSharedStageBackground(shared, 'blob:http://localhost/x'), { type: 'image', value: 'blob:http://localhost/x' });
    assert.deepEqual(resolveSharedStageBackground(shared, null), NONE);
    assert.deepEqual(resolveSharedStageBackground({ type: 'color', value: '#ff0000' }, null), { type: 'color', value: '#ff0000' });
    assert.deepEqual(resolveSharedStageBackground({ type: 'video', value: 'blob:http://host/v' }, null), NONE);
    assert.deepEqual(resolveSharedStageBackground({ type: 'image', value: '' }, null), NONE);
    assert.deepEqual(resolveSharedStageBackground(undefined, null), NONE);
  });

  it('uploads a normalized picture with the stage upload token and returns its id', async () => {
    const picture = new Blob([new Uint8Array(1024)], { type: 'image/webp' });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (url.startsWith('data:')) return new Response(picture);
      return new Response(JSON.stringify({ imageId: 'img-42' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const imageId = await uploadCanvasBackground(
      { type: 'image', value: 'data:image/webp;base64,AAAA' },
      { roomId: 'room-1', participantId: 'host-1', token: 'upload-token' },
      fetchImpl,
    );
    assert.equal(imageId, 'img-42');
    const post = requests[1];
    assert.equal(post.url, '/api/rooms/room-1/stage-images');
    assert.equal(post.init?.method, 'POST');
    assert.deepEqual(post.init?.headers, { 'Content-Type': 'image/webp', 'X-Participant-Id': 'host-1', 'X-Stage-Token': 'upload-token' });
    assert.equal((post.init?.body as Blob).size, 1024);
  });

  it('reports a refused upload instead of sharing the picture inline', async () => {
    const fetchImpl = (async (url: string) => (url.startsWith('data:')
      ? new Response(new Blob([new Uint8Array(16)], { type: 'image/png' }))
      : new Response('{"error":"Not allowed"}', { status: 403 }))) as typeof fetch;
    await assert.rejects(
      uploadCanvasBackground({ type: 'image', value: 'data:image/png;base64,AAAA' }, { roomId: 'r', participantId: 'p', token: 't' }, fetchImpl),
      /403/,
    );
  });

  it('caps uploads at the canvas background size', () => {
    assert.equal(CANVAS_BACKGROUND_MAX_BYTES, 400 * 1024);
  });
});

/** A 2D context that records fills and draws. */
function recordingContext(width = 1920, height = 1080) {
  const calls: Array<{ op: string; fillStyle: unknown; args: unknown[] }> = [];
  const ctx = {
    canvas: { width, height },
    fillStyle: '' as unknown,
    fillRect(...args: unknown[]) { calls.push({ op: 'fillRect', fillStyle: ctx.fillStyle, args }); },
    drawImage(...args: unknown[]) { calls.push({ op: 'drawImage', fillStyle: ctx.fillStyle, args }); },
    createLinearGradient: () => ({ addColorStop: () => undefined, gradient: true }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe('program compositor canvas background', () => {
  it('fills the whole program frame with a custom colour', () => {
    const { ctx, calls } = recordingContext();
    drawStageBackground(ctx, { type: 'color', value: '#123456' }, null);
    assert.deepEqual(calls.map((call) => [call.op, call.fillStyle, call.args]), [
      ['fillRect', DEFAULT_PROGRAM_BACKGROUND, [0, 0, 1920, 1080]],
      ['fillRect', '#123456', [0, 0, 1920, 1080]],
    ]);
  });

  it('covers the frame with a loaded picture, cropping instead of stretching', () => {
    const { ctx, calls } = recordingContext(1080, 1920);
    const image = { complete: true, naturalWidth: 1920, width: 1920, height: 1080 } as HTMLImageElement;
    drawStageBackground(ctx, { type: 'image', value: 'blob:http://localhost/bg' }, image);
    const draw = calls.find((call) => call.op === 'drawImage');
    assert.ok(draw, 'picture drawn into the program frame');
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = draw.args as number[];
    assert.deepEqual([dx, dy, dw, dh], [0, 0, 1080, 1920]);
    assert.equal(sy, 0);
    assert.equal(sh, 1080);
    assert.ok(Math.abs(sw - 1080 * (1080 / 1920)) < 1e-6);
    assert.ok(Math.abs(sx - (1920 - sw) / 2) < 1e-6);
  });

  it('keeps the default fill until the picture has loaded', () => {
    const { ctx, calls } = recordingContext();
    drawStageBackground(ctx, { type: 'image', value: 'blob:http://localhost/bg' }, { complete: false, naturalWidth: 0 } as HTMLImageElement);
    assert.deepEqual(calls.map((call) => call.op), ['fillRect']);
    const none = recordingContext();
    drawStageBackground(none.ctx, { type: 'image', value: '', imageId: 'not-loaded' }, null);
    assert.deepEqual(none.calls.map((call) => call.fillStyle), [DEFAULT_PROGRAM_BACKGROUND]);
  });
});
