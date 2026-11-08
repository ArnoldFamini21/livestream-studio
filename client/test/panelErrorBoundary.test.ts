import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createElement as h, useEffect, type ReactElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { ErrorBoundary, PanelErrorBoundary } from '../src/components/ErrorBoundary.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const lifecycle: string[] = [];
let shouldThrow = true;

/** Stands in for the stage and the media hooks: it must never unmount. */
function Stage() {
  useEffect(() => {
    lifecycle.push('stage mounted');
    return () => { lifecycle.push('stage unmounted'); };
  }, []);
  return h('div', { id: 'stage' }, 'stage');
}

function Bomb({ name }: { name: string }) {
  if (shouldThrow) throw new Error(`${name} exploded`);
  return h('div', { id: name }, `${name} ok`);
}

function Sibling() {
  useEffect(() => () => { lifecycle.push('sibling unmounted'); }, []);
  return h('div', { id: 'sibling' }, 'sibling panel');
}

function studio(resetKey: string): ReactElement {
  return h(ErrorBoundary, null,
    h('main', null,
      h(Stage),
      h(PanelErrorBoundary, { label: 'Chat', resetKey }, h(Bomb, { name: 'chat' })),
      h(PanelErrorBoundary, { label: 'Polls' }, h(Sibling)),
    ));
}

function text(renderer: ReactTestRenderer): string {
  const collect = (node: unknown): string => {
    if (typeof node === 'string') return node;
    if (!node || typeof node !== 'object') return '';
    const children = (node as { children?: unknown[] }).children || [];
    return children.map(collect).join(' ');
  };
  const json = renderer.toJSON();
  return (Array.isArray(json) ? json : [json]).map(collect).join(' ');
}

describe('PanelErrorBoundary', () => {
  const originalError = console.error;
  let logged: unknown[][] = [];
  beforeEach(() => {
    lifecycle.length = 0;
    shouldThrow = true;
    logged = [];
    console.error = (...args: unknown[]) => { logged.push(args); };
  });
  afterEach(() => { console.error = originalError; });

  it('replaces only the crashed panel and keeps the stage and its siblings mounted', () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(studio('a')); });

    const output = text(renderer);
    assert.match(output, /stage/);
    assert.match(output, /sibling panel/);
    assert.match(output, /This panel had a problem/);
    assert.doesNotMatch(output, /Something went wrong/, 'the studio-wide boundary was not reached');
    const alert = renderer.root.find((node) => node.props.role === 'alert');
    assert.equal(alert.props['aria-label'], 'Chat had a problem');
    assert.deepEqual(lifecycle, ['stage mounted']);
    assert.ok(logged.some((args) => String(args[0]).includes('[PanelErrorBoundary] Chat crashed')));
    act(() => { renderer.unmount(); });
  });

  it('mounts the panel afresh on "Reload panel"', () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(studio('a')); });
    shouldThrow = false;
    const reload = renderer.root.find((node) => node.type === 'button' && node.children.includes('Reload panel'));
    act(() => { reload.props.onClick(); });
    const output = text(renderer);
    assert.match(output, /chat ok/);
    assert.doesNotMatch(output, /This panel had a problem/);
    assert.deepEqual(lifecycle, ['stage mounted']);
    act(() => { renderer.unmount(); });
  });

  it('tries again by itself when its reset key changes', () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(studio('a')); });
    shouldThrow = false;
    act(() => { renderer.update(studio('a')); });
    assert.match(text(renderer), /This panel had a problem/, 'the same key keeps the fallback');
    act(() => { renderer.update(studio('b')); });
    assert.match(text(renderer), /chat ok/);
    assert.deepEqual(lifecycle, ['stage mounted']);
    act(() => { renderer.unmount(); });
  });
});

describe('StudioRoom panel boundaries', () => {
  it('wraps the side panels, dialogs and overlay layer, but never the stage', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/components/StudioRoom.tsx', import.meta.url), 'utf8');
    const lines = source.split('\n');
    let depth = 0;
    const wrapped = new Set<string>();
    for (const line of lines) {
      if (line.includes('<PanelErrorBoundary')) depth += 1;
      const tag = /^\s*<([A-Z][A-Za-z]+)/.exec(line)?.[1];
      if (tag && depth > 0) wrapped.add(tag);
      if (tag === 'StageCanvas' || tag === 'ControlBar') assert.equal(depth, 0, `${tag} must stay outside panel boundaries`);
      if (line.includes('</PanelErrorBoundary>')) depth -= 1;
      assert.ok(depth >= 0 && depth <= 1, 'boundaries are balanced and not nested');
    }
    assert.equal(depth, 0);
    for (const panel of ['ChatPanel', 'Sidebar', 'RecordingPanel', 'ProducerPanel', 'StreamDestinationsPanel', 'DeviceSelector',
      'LivePollsPanel', 'WebinarQAPanel', 'LiveCaptionsPanel', 'InvitePanel', 'SoundBoard', 'BackgroundMusic', 'ConfirmDialog',
      'BannerOverlayDisplay', 'ReactionOverlay', 'LiveCaptionOverlay',
      // Wave 2 panels and editors.
      'ProgramReturnMonitor', 'CustomLayoutEditor', 'GuestCaptionShare', 'StageRemoteControl']) {
      assert.ok(wrapped.has(panel), `${panel} is inside a PanelErrorBoundary`);
    }
  });
});
