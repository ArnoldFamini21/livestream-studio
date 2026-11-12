import { useId, useState } from 'react';
import type {
  ChatOverlayLayout,
  ChatOverlayMode,
  ChatOverlayPatch,
  ChatOverlaySide,
  ChatOverlaySize,
  ChatOverlayState,
} from '@studio/shared';

export interface ChatOverlayPanelProps {
  state: ChatOverlayState;
  onUpdate: (patch: ChatOverlayPatch) => void;
  onSetPaused: (paused: boolean) => void;
  /** The server syncs the settings to co-hosts; without it they stay in this browser. */
  serverSupported: boolean;
}

const SIZES: Array<[ChatOverlaySize, string]> = [['s', 'S'], ['m', 'M'], ['l', 'L']];
const LAYOUTS: Array<[ChatOverlayLayout, string]> = [['regular', 'Regular'], ['tall', 'Tall'], ['wide', 'Wide']];
const SIDES: Array<[ChatOverlaySide, string]> = [['left', 'Left'], ['right', 'Right']];
const MODES: Array<[ChatOverlayMode, string]> = [['all', 'All comments'], ['approved', 'Approved only']];

function Segmented<T extends string>({ label, options, value, onChange }: {
  label: string; options: Array<[T, string]>; value: T; onChange: (value: T) => void;
}) {
  return <div className="chat-overlay-field" role="group" aria-label={label}>
    <span>{label}</span>
    <div className="chat-overlay-segments">
      {options.map(([key, text]) => <button key={key} type="button" aria-pressed={value === key} onClick={() => onChange(key)}>{text}</button>)}
    </div>
  </div>;
}

/** Host and co-host controls for the on-screen chat, shown at the top of the chat panel. */
export function ChatOverlayControls({ state, onUpdate, onSetPaused, serverSupported }: ChatOverlayPanelProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return <div className="chat-overlay-controls" data-on={state.enabled || undefined}>
    <div className="chat-overlay-bar">
      <button type="button" className="chat-overlay-toggle" aria-pressed={state.enabled} onClick={() => onUpdate({ enabled: !state.enabled })}>
        <span className="chat-overlay-dot" aria-hidden="true" />
        Chat on screen: {state.enabled ? 'On' : 'Off'}
      </button>
      <button type="button" className="chat-overlay-more" aria-expanded={open} aria-controls={panelId} aria-label="Chat on screen settings" onClick={() => setOpen(value => !value)}>
        {open ? 'Done' : 'Settings'}
      </button>
    </div>
    {state.enabled && state.paused && <p className="chat-overlay-note" role="status">Paused: new comments wait until you resume.</p>}
    {open && <div id={panelId} className="chat-overlay-panel">
      <Segmented label="Size" options={SIZES} value={state.size} onChange={size => onUpdate({ size })} />
      <Segmented label="Layout" options={LAYOUTS} value={state.layout} onChange={layout => onUpdate({ layout })} />
      <Segmented label="Side" options={SIDES} value={state.side} onChange={side => onUpdate({ side })} />
      <Segmented label="Show" options={MODES} value={state.mode} onChange={mode => onUpdate({ mode })} />
      <div className="chat-overlay-actions">
        <button type="button" aria-pressed={state.paused} onClick={() => onSetPaused(!state.paused)}>{state.paused ? 'Resume chat' : 'Pause chat'}</button>
        <button type="button" disabled={state.hiddenIds.length === 0} onClick={() => onUpdate({ clearHidden: true })}>
          Show hidden{state.hiddenIds.length ? ` (${state.hiddenIds.length})` : ''}
        </button>
      </div>
      {state.mode === 'approved' && <p className="chat-overlay-note">Only comments you star or show on stage appear.</p>}
      {!serverSupported && <p className="chat-overlay-note">Co-hosts will not see these changes until the studio updates. They stay in this browser.</p>}
    </div>}
  </div>;
}
