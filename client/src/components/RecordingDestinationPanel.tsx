import { useState } from 'react';
import type { TakeChecklist, TakeReceiptState } from '../utils/recordingTakeChecklist.ts';
import type { ParticipantTransferSummary } from '../utils/recordingTransferSession.ts';
import type { RecordingDestinationPreferences } from '../hooks/useRecordingDestination.ts';
import type { RecordingFolderStatus } from '../utils/recordingFolderStore.ts';

export interface RecordingDestinationPanelProps {
  status: RecordingFolderStatus;
  folderName: string | null;
  error: string | null;
  persisted: boolean | null;
  preferences: RecordingDestinationPreferences;
  cloudAvailable: boolean;
  privateRecovery?: { selected: boolean; setSelected: (selected: boolean) => void };
  transfers: ParticipantTransferSummary[];
  checklists: TakeChecklist[];
  checklistError: string | null;
  retryableGuests: ReadonlySet<string>;
  onRetryGuestTake: (takeId: string, participantId: string) => boolean;
  disabled?: boolean;
  onChooseFolder: () => void;
  onReconnectFolder: () => void;
  onForgetFolder: () => void;
  onPreferencesChange: (patch: Partial<RecordingDestinationPreferences>) => void;
}

export function describeTransfer(summary: ParticipantTransferSummary): string {
  if (summary.tracks > 0 && summary.completeTracks === summary.tracks) return `${summary.participantName}'s tracks saved to your folder`;
  if (summary.failedTracks > 0) return `${summary.participantName}: ${summary.failedTracks} track${summary.failedTracks === 1 ? '' : 's'} could not be saved (kept in their browser)`;
  const state = summary.connected ? '' : ' (waiting to reconnect)';
  return `Receiving ${summary.participantName}'s tracks — ${summary.percent}%${state}`;
}

/** Where takes are recorded, plus live progress of guests' tracks arriving. */
export function RecordingDestinationPanel(props: RecordingDestinationPanelProps) {
  const { status, folderName, preferences } = props;
  return (
    <section className="recording-folder-save" aria-label="Recording destination">
      <strong style={{ fontSize: 12 }}>Recording storage</strong>
      {status === 'unsupported' && (
        <p className="recording-folder-save-help">
          Recordings save to this device. Use Download all to move a saved take to a folder.
        </p>
      )}
      {status === 'none' && (
        <>
          <p className="recording-folder-save-help">
            Recordings save in this browser. Choose a folder to save tracks directly to your drive.
          </p>
          <button type="button" className="recording-folder-save-button" onClick={props.onChooseFolder} disabled={props.disabled}>
            Choose recording folder
          </button>
        </>
      )}
      {(status === 'needs-permission' || status === 'denied') && (
        <>
          <p className="recording-folder-save-help">
            Reconnect <strong>{folderName || 'your recording folder'}</strong> to save there.
          </p>
          <button type="button" className="recording-folder-save-button" onClick={props.onReconnectFolder} disabled={props.disabled}>
            Reconnect {folderName || 'folder'}
          </button>{' '}
          <button type="button" className="recording-folder-save-button" onClick={props.onChooseFolder} disabled={props.disabled}>
            Choose another
          </button>
        </>
      )}
      {status === 'ready' && (
        <>
          <p className="recording-folder-save-status" role="status">
            Saving to <strong>{folderName || 'your folder'}</strong>.
          </p>
          <button type="button" className="recording-folder-save-button" onClick={props.onChooseFolder} disabled={props.disabled}>
            Change folder
          </button>{' '}
          <details className="recording-storage-options">
          <summary>Recording options</summary>
          <button type="button" className="recording-folder-save-button" onClick={props.onForgetFolder} disabled={props.disabled}>Disconnect folder</button>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, fontSize: 11 }}>
            <input
              type="checkbox"
              checked={preferences.losslessAudio}
              disabled={props.disabled}
              onChange={(event) => props.onPreferencesChange({ losslessAudio: event.target.checked })}
            />
            Include lossless WAV mic tracks
          </label>
          {props.cloudAvailable && (
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, fontSize: 11 }}>
              <input
                type="checkbox"
                checked={preferences.cloudUpload}
                disabled={props.disabled}
                onChange={(event) => props.onPreferencesChange({ cloudUpload: event.target.checked })}
              />
              Upload tracks for cloud export
            </label>
          )}
          </details>
        </>
      )}
      {props.persisted === false && status !== 'ready' && (
        <p className="recording-folder-save-help">Download saved recordings to protect them if this device runs low on space.</p>
      )}
      {props.privateRecovery && <label className="recording-private-backup-option">
        <input type="checkbox" checked={props.privateRecovery.selected} disabled={props.disabled}
          onChange={event => props.privateRecovery?.setSelected(event.target.checked)} />
        <span>Private guest backup for next take<small>On-stage guests can upload from their device for seven days.</small></span>
      </label>}
      {status === 'ready' && <RecordingTakeChecklists
        takes={props.checklists}
        error={props.checklistError}
        disabled={props.disabled}
        retryableGuests={props.retryableGuests}
        onRetry={props.onRetryGuestTake}
      />}
      {props.error && <p role="alert" className="recording-folder-save-error">{props.error}</p>}
      {props.transfers.some(transfer => transfer.percent < 100 || transfer.failedTracks > 0) && (
        <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, fontSize: 11 }} aria-label="Guest track transfers">
          {props.transfers.filter(summary => summary.percent < 100 || summary.failedTracks > 0).map((summary) => (
            <li key={summary.participantId} style={{ marginTop: 4 }}>
              {describeTransfer(summary)}
              {summary.percent < 100 && (
                <progress value={summary.percent} max={100} style={{ display: 'block', width: '100%', height: 4 }} aria-hidden="true" />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const receiptLabels: Record<TakeReceiptState, string> = {
  recording: 'Recording',
  transferring: 'Transferring',
  missing: 'Missing',
  verified: 'Saved to folder',
};

function RecordingTakeChecklists({ takes, error, disabled, retryableGuests, onRetry }: {
  takes: TakeChecklist[];
  error: string | null;
  disabled?: boolean;
  retryableGuests: ReadonlySet<string>;
  onRetry: (takeId: string, participantId: string) => boolean;
}) {
  const [selected, setSelected] = useState('');
  const [notice, setNotice] = useState<{ take: string; message: string } | null>(null);
  const take = takes.find(item => item.id === selected) ?? takes[0];
  const retries = new Map<string, string>();
  for (const row of take?.rows ?? []) {
    if (row.state === 'missing' && row.participantId && row.participantName && retryableGuests.has(row.participantId)) {
      retries.set(row.participantId, row.participantName);
    }
  }
  return (
    <details className="recording-take-checklist">
      <summary>Take checklist</summary>
      {error && <p role="alert" className="recording-folder-save-error">{error}</p>}
      {!take && <p>Your folder has no saved takes for this studio yet.</p>}
      {take && <>
        <label>
          <span>Take</span>
          <select value={take.id} onChange={event => setSelected(event.target.value)}>
            {takes.map(item => <option key={item.id} value={item.id}>{new Date(item.startedAt).toLocaleString()}</option>)}
          </select>
        </label>
        <ul aria-label="Tracks in the selected take">
          {take.rows.map(row => <li key={row.key}>
            <span>{row.label}</span>
            <span data-state={row.state}>{receiptLabels[row.state]}</span>
          </li>)}
        </ul>
        {[...retries].map(([guest, name]) => (
          <button key={guest} type="button" className="recording-folder-save-button"
            disabled={disabled || take.rows.some(row => row.participantId === guest && row.state === 'transferring')}
            onClick={() => {
              const sent = onRetry(take.id, guest);
              setNotice({ take: take.id, message: sent
                ? 'Requested the missing tracks. The guest’s original recording must still be available in their browser.'
                : 'The guest must be admitted to this studio before their tracks can be requested.' });
            }}>Request tracks from {name}</button>
        ))}
        {notice?.take === take.id && <p role="status">{notice.message}</p>}
      </>}
    </details>
  );
}

/** Compact on-stage line while guests' tracks are still arriving. */
export function RecordingTransferBadge({ transfers, guestLine }: { transfers: ParticipantTransferSummary[]; guestLine?: string | null }) {
  const active = transfers.filter((summary) => summary.completeTracks < summary.tracks);
  if (!active.length && !guestLine) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed', left: 16, bottom: 88, zIndex: 40, maxWidth: 'min(360px, calc(100vw - 32px))',
        padding: '8px 10px', borderRadius: 8, fontSize: 12, lineHeight: 1.4,
        color: 'var(--text-primary)', background: 'var(--bg-secondary)', border: '1px solid var(--border-strong)',
      }}
    >
      {guestLine && <div>{guestLine}</div>}
      {active.slice(0, 4).map((summary) => <div key={summary.participantName}>{describeTransfer(summary)}</div>)}
      {active.length > 4 && <div>+{active.length - 4} more</div>}
    </div>
  );
}
