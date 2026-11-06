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
  transfers: ParticipantTransferSummary[];
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
      <strong style={{ fontSize: 12 }}>Recording folder</strong>
      {status === 'unsupported' && (
        <p className="recording-folder-save-help">
          This browser cannot record straight into a folder. Takes are kept in browser storage while recording; afterwards use
          <strong> Download all</strong> — every track downloads as its own file (set your browser’s download location to your SSD).
          Desktop Chrome or Edge records directly to your SSD and collects guests’ tracks there.
        </p>
      )}
      {status === 'none' && (
        <>
          <p className="recording-folder-save-help">
            Choose a folder once (e.g. on your external SSD). Every take — yours and your guests’ — is written there while you record,
            in <em>Studio / date take / person</em> folders. Nothing is uploaded.
          </p>
          <button type="button" className="recording-folder-save-button" onClick={props.onChooseFolder} disabled={props.disabled}>
            Choose recording folder
          </button>
        </>
      )}
      {(status === 'needs-permission' || status === 'denied') && (
        <>
          <p className="recording-folder-save-help">
            Your browser needs permission again to write to <strong>{folderName || 'your recording folder'}</strong>.
            {status === 'denied' ? ' Access was blocked; allow it in the site settings or choose the folder again.' : ' It is also asked when you press Record.'}
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
            Recording straight to <strong>{folderName || 'your folder'}</strong>. Guests’ tracks are sent to it directly during the take.
          </p>
          <button type="button" className="recording-folder-save-button" onClick={props.onChooseFolder} disabled={props.disabled}>
            Change folder
          </button>{' '}
          <button type="button" className="recording-folder-save-button" onClick={props.onForgetFolder} disabled={props.disabled}>
            Stop using it
          </button>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, fontSize: 11 }}>
            <input
              type="checkbox"
              checked={preferences.losslessAudio}
              disabled={props.disabled}
              onChange={(event) => props.onPreferencesChange({ losslessAudio: event.target.checked })}
            />
            Lossless WAV mic track for everyone (48 kHz, raw microphone, about 520 MB per hour each)
          </label>
          {props.cloudAvailable && (
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, fontSize: 11 }}>
              <input
                type="checkbox"
                checked={preferences.cloudUpload}
                disabled={props.disabled}
                onChange={(event) => props.onPreferencesChange({ cloudUpload: event.target.checked })}
              />
              Also upload tracks to the configured cloud storage
            </label>
          )}
        </>
      )}
      {status !== 'ready' && status !== 'unsupported' && (
        <p className="recording-folder-save-help">Until a folder is connected, takes are saved in this browser’s storage on this computer.</p>
      )}
      {props.persisted === false && status !== 'ready' && (
        <p className="recording-folder-save-help">The browser may clear its storage when the disk is nearly full; save takes to a folder soon after recording.</p>
      )}
      {props.error && <p role="alert" className="recording-folder-save-error">{props.error}</p>}
      {props.transfers.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, fontSize: 11 }} aria-label="Guest track transfers">
          {props.transfers.map((summary) => (
            <li key={summary.participantName} style={{ marginTop: 4 }}>
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
