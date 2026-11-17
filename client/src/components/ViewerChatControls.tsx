import { useEffect, useId, useRef, useState } from 'react';
import { viewerMessagesGoStraightOnAir } from '../utils/viewerChatNotes.ts';
import type { ChatOverlayPatch, ChatOverlayState, ViewerBlockScope, ViewerChatStatePayload, ViewerChatSwitches } from '@studio/shared';

/** What a block is aimed at: the id of the viewer's chat message or question, and the name that viewer used. */
export interface ViewerBlockTarget {
  id: string;
  name: string;
}

/** What the switches panel needs to know about the on-screen chat, to warn the host when viewers would go straight on air. */
export interface ViewerChatOverlayInfo {
  state: Pick<ChatOverlayState, 'enabled' | 'mode'>;
  onUpdate: (patch: ChatOverlayPatch) => void;
}

export interface ViewerChatPanelProps {
  state: ViewerChatStatePayload;
  /** The server knows about viewer chat; an older one does not, and the switches would do nothing. */
  serverSupported: boolean;
  onSetSwitch: (key: keyof ViewerChatSwitches, value: boolean) => void;
  onRemove: (messageId: string) => void;
  onBlock: (messageId: string, scope: ViewerBlockScope) => void;
  onUnblock: (blockId: string) => void;
}

const SWITCHES: Array<[keyof ViewerChatSwitches, string]> = [
  ['chat', 'Viewers can chat'],
  ['reactions', 'Viewers can react'],
  ['questions', 'Viewers can ask questions'],
];

/**
 * Host and co-host controls for the public watch page: three switches (all off
 * until turned on here) and the list of blocked viewers. The server enforces
 * the switches, so a switch that is off also refuses a hand-made request.
 */
export function ViewerChatControls({ state, serverSupported, onSetSwitch, onUnblock, overlay }: ViewerChatPanelProps & { overlay?: ViewerChatOverlayInfo }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const onCount = SWITCHES.filter(([key]) => state.switches[key]).length;
  const goesStraightOnAir = viewerMessagesGoStraightOnAir(state.switches, overlay?.state);
  return <div className="viewer-chat-controls" data-on={onCount > 0 || undefined}>
    <div className="chat-overlay-bar">
      <button type="button" className="chat-overlay-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
        <span className="chat-overlay-dot" aria-hidden="true" style={onCount > 0 ? { background: '#22c55e', boxShadow: '0 0 0 3px #22c55e33' } : undefined} />
        Watch page viewers: {onCount > 0 ? `${onCount} of 3 on` : 'Off'}
        {state.blocks.length > 0 && <span className="viewer-chat-blocked-count"> · {state.blocks.length} blocked</span>}
      </button>
      <button type="button" className="chat-overlay-more" aria-expanded={open} aria-controls={panelId} aria-label="Watch page viewer settings" onClick={() => setOpen(value => !value)}>
        {open ? 'Done' : 'Settings'}
      </button>
    </div>
    {goesStraightOnAir && overlay && <div className="viewer-chat-warning" role="status">
      <p>Chat on screen is showing all comments. A viewer&apos;s message will appear on the broadcast as soon as it is sent.</p>
      <button type="button" onClick={() => overlay.onUpdate({ mode: 'approved' })}>Show only approved comments</button>
    </div>}
    {open && <div id={panelId} className="chat-overlay-panel">
      {SWITCHES.map(([key, label]) => <div key={key} className="chat-overlay-field">
        <span>{label}</span>
        <button type="button" className="viewer-chat-switch" role="switch" aria-checked={state.switches[key]} aria-label={label} disabled={!serverSupported} onClick={() => onSetSwitch(key, !state.switches[key])}>
          {state.switches[key] ? 'On' : 'Off'}
        </button>
      </div>)}
      <p className="chat-overlay-note">Everything starts off. People on the watch page see only what you turn on. Their messages appear here marked Viewer.</p>
      <p className="chat-overlay-note">Viewer messages are shown to everyone watching. If Chat on screen is on, they can also appear on the broadcast. Public chat lines you write in the studio show on the watch page too while viewer chat is on. Each time you turn viewer chat on, the watch page list starts empty.</p>
      {!serverSupported && <p className="chat-overlay-note">The studio needs an update before these switches work. Reload in a few minutes.</p>}
      <div className="viewer-chat-blocked">
        <strong>Blocked viewers</strong>
        {state.blocks.length === 0 && <p className="chat-overlay-note">No one is blocked. A block lasts until this studio closes. If the server restarts, the blocks and these switches start over.</p>}
        {state.blocks.map((block) => <div key={block.id} className="viewer-chat-blocked-row">
          <span>
            <span className="viewer-chat-blocked-name">{block.name}</span>
            <small>{block.scope === 'network' ? 'Everyone on the same network' : 'This viewer only'}</small>
          </span>
          <button type="button" onClick={() => onUnblock(block.id)} aria-label={`Unblock ${block.name}`}>Unblock</button>
        </div>)}
      </div>
    </div>}
  </div>;
}

/**
 * Asks which viewers to block, in plain words. Two choices and Cancel; nothing
 * is blocked until one of the two is chosen.
 */
export function ViewerBlockDialog({ target, onChoose, onCancel }: {
  /** The viewer's chat message or question the host is acting on (its id), and the name the viewer used. */
  target: ViewerBlockTarget | null;
  onChoose: (target: ViewerBlockTarget, scope: ViewerBlockScope) => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const open = target !== null;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); return; }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!target) return null;
  const name = target.name;
  return <div className="viewer-block-overlay" role="dialog" aria-modal="true" aria-labelledby="viewer-block-title" onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div ref={dialogRef} className="viewer-block-dialog">
      <h2 id="viewer-block-title">Block this viewer?</h2>
      <p>Their earlier messages and questions will be removed. They cannot send anything new until you unblock them. Their name was <strong>{name}</strong>.</p>
      <button type="button" className="viewer-block-choice" data-choice="viewer" onClick={() => onChoose(target, 'viewer')}>
        <strong>Block this viewer only</strong>
        <span>Blocks this person&apos;s browser. A private window or cleared browsing data gets around it, so block the network too if they come back. Other people on the same Wi-Fi can still write.</span>
      </button>
      <button type="button" className="viewer-block-choice" data-choice="network" onClick={() => onChoose(target, 'network')}>
        <strong>Block this viewer and everyone on the same network</strong>
        <span>This also blocks other people on the same Wi-Fi, and sometimes other people on the same mobile data network. At a church, that can be many people.</span>
      </button>
      <button ref={cancelRef} type="button" className="viewer-block-cancel" onClick={onCancel}>Cancel</button>
    </div>
  </div>;
}
