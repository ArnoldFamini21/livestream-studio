import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyMediaAccessError,
  createMediaAccessProblem,
  detectBrowserFamily,
  getMediaAccessHelpSteps,
  isMediaPermissionBlock,
  isTransientMediaAccessError,
  withMediaAccessDevice,
} from '../src/utils/mediaAccessErrors.ts';

const domError = (name: string) => Object.assign(new Error(name), { name });

describe('camera and microphone access problems', () => {
  it('names what went wrong instead of "no devices"', () => {
    assert.equal(classifyMediaAccessError(domError('NotAllowedError')), 'permission-denied');
    assert.equal(classifyMediaAccessError(domError('NotReadableError')), 'in-use');
    assert.equal(classifyMediaAccessError(domError('NotFoundError')), 'not-found');
    assert.equal(classifyMediaAccessError(domError('OverconstrainedError')), 'constraints');
    assert.equal(classifyMediaAccessError(domError('SecurityError')), 'insecure-context');
    assert.equal(classifyMediaAccessError(new Error('weird')), 'unknown');
    assert.equal(classifyMediaAccessError(undefined), 'unknown');
  });

  it('does not ask again for a blocked permission, but retries a busy device', () => {
    assert.equal(isMediaPermissionBlock(domError('NotAllowedError')), true);
    assert.equal(isMediaPermissionBlock(domError('NotReadableError')), false);
    assert.equal(isTransientMediaAccessError('in-use'), true);
    assert.equal(isTransientMediaAccessError('unknown'), true);
    assert.equal(isTransientMediaAccessError('permission-denied'), false);
  });

  it('says which device is affected', () => {
    const problem = createMediaAccessProblem(domError('NotAllowedError'), 'both');
    assert.equal(problem.message, 'Camera and microphone access is blocked for this site.');
    const cameraOnly = withMediaAccessDevice(problem, 'camera');
    assert.equal(cameraOnly.device, 'camera');
    assert.equal(cameraOnly.message, 'Camera access is blocked for this site.');
    assert.match(createMediaAccessProblem(domError('NotReadableError'), 'microphone').message, /microphone is busy/);
  });

  it('recognises the browsers guests use', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
    const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    const edge = `${chrome} Edg/130.0.0.0`;
    assert.equal(detectBrowserFamily({ userAgent: iphone }), 'ios');
    assert.equal(detectBrowserFamily({ userAgent: ipad, maxTouchPoints: 5 }), 'ios');
    assert.equal(detectBrowserFamily({ userAgent: ipad, maxTouchPoints: 0 }), 'safari');
    assert.equal(detectBrowserFamily({ userAgent: chrome }), 'chrome');
    assert.equal(detectBrowserFamily({ userAgent: edge }), 'edge');
    assert.equal(detectBrowserFamily({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' }), 'firefox');
    assert.equal(detectBrowserFamily({ userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36' }), 'android');
  });

  it('gives browser-specific steps to unblock, and app tips for a busy device', () => {
    assert.match(getMediaAccessHelpSteps('permission-denied', 'safari').join(' '), /Settings for This Website/);
    assert.match(getMediaAccessHelpSteps('permission-denied', 'ios').join(' '), /Website Settings/);
    assert.match(getMediaAccessHelpSteps('permission-denied', 'chrome').join(' '), /address bar/);
    assert.match(getMediaAccessHelpSteps('in-use', 'chrome').join(' '), /Zoom/);
    assert.deepEqual(getMediaAccessHelpSteps('unknown', 'chrome'), []);
  });
});
