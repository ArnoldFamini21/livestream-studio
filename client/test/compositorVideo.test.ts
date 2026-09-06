import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canDrawMediaImage,
  canDrawMediaVideo,
  getCompositorVideoDrawPlan,
  getCompositorVideoObjectFit,
  isCompositorVideoHorizontallyMirrored,
} from '../src/utils/compositorVideo.ts';

describe('compositor video drawing', () => {
  const readyVideo = {
    readyState: 2,
    videoWidth: 1920,
    videoHeight: 1080,
    crossOrigin: null,
    currentSrc: '',
    src: 'https://studio.example.com/clip.mp4',
  };

  it('draws local clips and loaded remote clips requested with anonymous CORS', () => {
    const page = 'https://studio.example.com/room';
    assert.equal(canDrawMediaVideo(readyVideo, page), true);
    assert.equal(canDrawMediaVideo({ ...readyVideo, src: 'blob:https://studio.example.com/clip' }, page), true);
    assert.equal(canDrawMediaVideo({ ...readyVideo, src: 'https://media.example.com/clip.mp4', crossOrigin: 'anonymous' }, page), true);
  });

  it('keeps failed CORS loads and unsafe remote sources away from the recording canvas', () => {
    const page = 'https://studio.example.com/room';
    const remoteVideo = { ...readyVideo, src: 'https://media.example.com/clip.mp4' };
    assert.equal(canDrawMediaVideo(remoteVideo, page), false);
    assert.equal(canDrawMediaVideo({ ...remoteVideo, crossOrigin: 'anonymous', readyState: 0 }, page), false);
    assert.equal(canDrawMediaVideo({ ...remoteVideo, crossOrigin: 'anonymous', videoWidth: 0 }, page), false);
    assert.equal(canDrawMediaVideo({ ...remoteVideo, currentSrc: 'https://media.example.com/redirect.mp4' }, page), false);
    assert.equal(canDrawMediaVideo({ ...readyVideo, src: 'javascript:alert(1)', crossOrigin: 'anonymous' }, page), false);
  });

  it('draws the loaded stage image only when its pixels are safe for recording', () => {
    const page = 'https://studio.example.com/room';
    const image = {
      complete: true, naturalWidth: 1200, naturalHeight: 800,
      currentSrc: 'https://images.example.com/slide.png', src: '', crossOrigin: 'anonymous',
    };
    assert.equal(canDrawMediaImage(image, page), true);
    assert.equal(canDrawMediaImage({ ...image, crossOrigin: null }, page), false);
    assert.equal(canDrawMediaImage({ ...image, naturalWidth: 0 }, page), false);
    assert.equal(canDrawMediaImage({ ...image, complete: false }, page), false);
  });

  it('letterboxes contained screen shares without stretching them', () => {
    assert.deepEqual(
      getCompositorVideoDrawPlan(1280, 1024, 1920, 1080, 'contain'),
      {
        sourceX: 0,
        sourceY: 0,
        sourceWidth: 1280,
        sourceHeight: 1024,
        destX: 285,
        destY: 0,
        destWidth: 1350,
        destHeight: 1080,
      }
    );
  });

  it('crops cover video sources to fill participant camera tiles', () => {
    assert.deepEqual(
      getCompositorVideoDrawPlan(1920, 1080, 800, 800, 'cover'),
      {
        sourceX: 420,
        sourceY: 0,
        sourceWidth: 1080,
        sourceHeight: 1080,
        destX: 0,
        destY: 0,
        destWidth: 800,
        destHeight: 800,
      }
    );
  });

  it('falls back to fill when no supported object-fit value is present', () => {
    assert.deepEqual(
      getCompositorVideoDrawPlan(1920, 1080, 640, 360, 'fill'),
      {
        sourceX: 0,
        sourceY: 0,
        sourceWidth: 1920,
        sourceHeight: 1080,
        destX: 0,
        destY: 0,
        destWidth: 640,
        destHeight: 360,
      }
    );
  });

  it('rejects unusable dimensions', () => {
    assert.equal(getCompositorVideoDrawPlan(0, 1080, 640, 360, 'contain'), null);
    assert.equal(getCompositorVideoDrawPlan(1920, 1080, 0, 360, 'cover'), null);
  });

  it('reads inline fit and mirror flags from DOM video styles', () => {
    const video = {
      style: {
        objectFit: 'contain',
        transform: 'scaleX(-1)',
      },
    } as unknown as HTMLVideoElement;

    assert.equal(getCompositorVideoObjectFit(video), 'contain');
    assert.equal(isCompositorVideoHorizontallyMirrored(video), true);
  });
});
