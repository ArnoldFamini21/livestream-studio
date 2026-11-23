import { useEffect, useRef } from 'react';
import type { ParticipantStatus } from '@studio/shared';
import type { MediaDeviceInfo } from '../hooks/useMediaDevices.ts';
import type { MediaAccessProblem } from '../utils/mediaAccessErrors.ts';
import { MediaAccessHelp } from './MediaAccessHelp.tsx';
import '../styles/secondary-camera.css';

interface SecondaryCameraSeatProps {
  label: string;
  roomName: string;
  stream: MediaStream | null;
  status: ParticipantStatus;
  videoEnabled: boolean;
  recording: boolean;
  saving: boolean;
  transferStatus?: string | null;
  notification?: string | null;
  mediaError?: string | null;
  connected: boolean;
  retryConnection?: () => void;
  mediaProblem: MediaAccessProblem | null;
  retryMedia: () => Promise<boolean>;
  devices: MediaDeviceInfo[];
  deviceId: string;
  onDeviceChange: (id: string) => void;
  onToggleCamera: () => void;
  onLeave: () => void;
}

export function SecondaryCameraSeat(props: SecondaryCameraSeatProps) {
  const preview = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (preview.current) preview.current.srcObject = props.stream;
  }, [props.stream, props.videoEnabled]);
  const seatStatus = props.status === 'on-stage' ? 'On stage'
    : props.status === 'backstage' ? 'Backstage'
      : 'Waiting for the host to admit this camera';
  return (
    <main className="secondary-camera">
      <div className="secondary-camera-heading">
        <p>{props.roomName}</p>
        <h1>{props.label}</h1>
      </div>
      <div className="secondary-camera-preview">
        {props.videoEnabled ? <video ref={preview} autoPlay playsInline muted aria-label="Secondary camera preview" /> : 'Camera off'}
      </div>
      <p role="status">
        {!props.connected ? 'Reconnecting to the studio…' : seatStatus}
        {props.recording ? ' · Recording camera ISO' : ''}
        {props.saving ? ' · Saving the recording' : ''}
      </p>
      {props.retryConnection && <button className="btn-ghost" type="button" onClick={props.retryConnection}>Retry connection</button>}
      {props.transferStatus && <p role="status">{props.transferStatus}</p>}
      {props.notification && <p role="status">{props.notification}</p>}
      {props.mediaProblem ? <MediaAccessHelp problem={props.mediaProblem} onRetry={props.retryMedia} /> : props.mediaError && <p role="alert">{props.mediaError}</p>}
      <div className="secondary-camera-actions">
        {props.devices.length > 1 && (
          <label>
            Camera
            <select value={props.deviceId} onChange={event => props.onDeviceChange(event.target.value)}>
              {props.devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
            </select>
          </label>
        )}
        <button className="btn-ghost" type="button" onClick={props.onToggleCamera}>
          {props.videoEnabled ? 'Turn off camera' : 'Turn on camera'}
        </button>
        <button className="btn-ghost" type="button" onClick={props.onLeave} disabled={props.saving}>Disconnect camera</button>
      </div>
    </main>
  );
}
