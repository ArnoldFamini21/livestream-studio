import { useEffect, useRef, useState } from 'react';
import type { Participant, RecordingUploadProgressPayload, StageActionPayload } from '@studio/shared';
import type { PeerBandwidthHealth } from '../utils/webrtcBandwidthAdaptation.ts';
import { formatPeerBandwidthHealthTitle } from '../utils/peerBandwidthDisplay.ts';
import { describeRecordingUploadProgress } from '../utils/recordingUploadProgress.ts';
import { AudioLevelMeter } from './AudioLevelMeter.tsx';
import { StudioIcon } from './StudioIcon.tsx';
import '../styles/people-panel.css';

export interface PeoplePanelProps {
  participants: Map<string, Participant>;
  myParticipantId: string;
  myRole: 'host' | 'co-host' | 'guest';
  onStageAction: (
    action: StageActionPayload['action'],
    targetId: string
  ) => void;
  focusedParticipantId: string | null;
  onSpotlightParticipant: (participantId: string | null) => void;
  remoteStreams: Map<string, MediaStream>;
  peerBandwidthHealth: Map<string, PeerBandwidthHealth>;
  localStream: MediaStream | null;
  participantVolumes: Record<string, number>;
  onParticipantVolumeChange: (participantId: string, volume: number) => void;
  audioDuckingEnabled: boolean;
  onAudioDuckingEnabledChange: (enabled: boolean) => void;
  onMessageParticipant: (participantId: string) => void;
  /** Latest background recording upload report per participant (hosts only). */
  recordingUploads?: Record<string, RecordingUploadProgressPayload>;
  onRecordingUploadControl?: (participantId: string, action: 'pause' | 'resume') => void;
}

export function PeoplePanel(props: PeoplePanelProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const host = props.myRole !== 'guest';
  const groups = [
    { id: 'green-room', label: 'Waiting room' },
    { id: 'on-stage', label: 'On stage' },
    { id: 'backstage', label: 'Backstage' },
  ] as const;
  const waiting = [...props.participants.values()].filter(
    (person) =>
      person.status === 'green-room' &&
      person.id !== props.myParticipantId &&
      person.role !== 'host'
  );
  return (
    <div className="people-panel">
      <div className="people-toolbar">
        <span>{props.participants.size} in studio</span>
        {host && (
          <button
            type="button"
            className="people-icon"
            aria-label="Audio mix settings"
            aria-expanded={settingsOpen}
            aria-controls="people-settings"
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            <StudioIcon name="settings" />
          </button>
        )}
      </div>
      {settingsOpen && host && (
        <div id="people-settings" className="people-settings">
          <label>
            <span>
              Auto ducking<small>Lower other audio while someone speaks.</small>
            </span>
            <input
              type="checkbox"
              checked={props.audioDuckingEnabled}
              onChange={(event) =>
                props.onAudioDuckingEnabledChange(event.target.checked)
              }
            />
          </label>
        </div>
      )}
      {groups.map((group) => {
        const members = [...props.participants.values()].filter(
          (person) => person.status === group.id
        );
        if (!members.length) return null;
        return (
          <section
            key={group.id}
            aria-label={group.label}
            className="people-group"
          >
            <div className="people-group-label">
              <span>
                {group.label} <small>{members.length}</small>
              </span>
              {group.id === 'green-room' && host && waiting.length > 1 && (
                <button
                  type="button"
                  className="people-text"
                  onClick={() =>
                    waiting.forEach((person) =>
                      props.onStageAction('move-to-stage', person.id)
                    )
                  }
                >
                  Admit all
                </button>
              )}
            </div>
            {members.map((person) => (
              <PersonRow
                key={person.id}
                {...props}
                person={person}
                expanded={expandedId === person.id}
                onExpand={() =>
                  setExpandedId(expandedId === person.id ? null : person.id)
                }
                onCollapse={() => setExpandedId(null)}
              />
            ))}
          </section>
        );
      })}
      {props.participants.size === 1 && (
        <p className="people-empty">
          Your guests will appear here when they join.
        </p>
      )}
    </div>
  );
}

function PersonRow({
  person,
  expanded,
  onExpand,
  onCollapse,
  ...props
}: PeoplePanelProps & {
  person: Participant;
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
}) {
  const [confirmAction, setConfirmAction] = useState<'remove' | 'ban' | null>(
    null
  );
  const optionsRef = useRef<HTMLButtonElement>(null);
  const isMe = person.id === props.myParticipantId;
  const host = props.myRole !== 'guest';
  const manageable = host && !isMe && person.role !== 'host';
  const stream = isMe
    ? props.localStream
    : props.remoteStreams.get(person.id) || null;
  const health = props.peerBandwidthHealth.get(person.id);
  const upload = host ? props.recordingUploads?.[person.id] : undefined;
  const uploadSummary = upload ? describeRecordingUploadProgress(upload) : null;
  const uploadControllable = Boolean(
    upload && !isMe && props.onRecordingUploadControl &&
    (upload.status === 'uploading' || upload.status === 'paused')
  );
  const spotlight = props.focusedParticipantId === person.id;
  const canMix = host && person.status === 'on-stage';
  const value = props.participantVolumes[person.id] ?? 1;
  const volume = Math.round(
    Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1)) * 100
  );
  const close = () => {
    setConfirmAction(null);
    onCollapse();
    optionsRef.current?.focus();
  };
  const action = (type: StageActionPayload['action']) => {
    props.onStageAction(type, person.id);
    close();
  };
  useEffect(() => {
    if (!expanded) setConfirmAction(null);
  }, [expanded]);
  return (
    <div
      className="people-row"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div className="people-person">
        <PersonPreview
          stream={stream}
          enabled={person.videoEnabled}
          name={person.name}
        />
        <div className="people-name">
          <strong title={person.name}>
            {person.name}
            {isMe ? ' (you)' : ''}
          </strong>
          <span>
            {spotlight
              ? 'Spotlighted'
              : person.role === 'host'
                ? 'Host'
                : person.role === 'co-host'
                  ? 'Co-host'
                  : !person.videoEnabled
                    ? 'Camera off'
                    : 'Guest'}
            {!person.audioEnabled ? ' · Muted' : ''}
          </span>
          {health &&
            (health.quality === 'poor' || health.quality === 'fair') && (
              <span
                className="people-link-warning"
                title={formatPeerBandwidthHealthTitle(health)}
              >
                Weak connection
              </span>
            )}
          {uploadSummary && (
            <span
              className={`people-upload is-${uploadSummary.tone}`}
              title={uploadSummary.detail}
            >
              {uploadSummary.label}
            </span>
          )}
        </div>
        {manageable &&
          (person.status === 'on-stage' ? (
            <button
              type="button"
              className={`people-icon${!person.audioEnabled ? ' is-muted' : ''}`}
              title={person.audioEnabled ? 'Mute microphone' : 'Ask to unmute'}
              aria-label={`${person.audioEnabled ? 'Mute' : 'Ask to unmute'} ${person.name}`}
              onClick={() => action(person.audioEnabled ? 'mute' : 'unmute')}
            >
              <StudioIcon name="mic" />
            </button>
          ) : (
            <button
              type="button"
              className="people-admit"
              aria-label={`Bring ${person.name} on stage`}
              onClick={() => action('move-to-stage')}
            >
              {person.status === 'green-room' ? 'Admit' : 'Add'}
            </button>
          ))}
        {(host || !isMe) && (
          <button
            ref={optionsRef}
            type="button"
            className="people-icon"
            aria-label={`Options for ${person.name}`}
            aria-expanded={expanded}
            aria-controls={`person-options-${person.id}`}
            onClick={onExpand}
          >
            <StudioIcon name="more" />
          </button>
        )}
      </div>
      {expanded && (
        <div
          className="people-options"
          id={`person-options-${person.id}`}
          role="group"
          aria-label={`Controls for ${person.name}`}
        >
          {canMix && (
            <label className="people-volume">
              <span>
                Broadcast volume <output>{volume}%</output>
              </span>
              <AudioLevelMeter
                stream={person.audioEnabled ? stream : null}
                size="small"
                orientation="horizontal"
              />
              <input
                type="range"
                min="0"
                max="100"
                value={volume}
                aria-label={`Broadcast volume for ${person.name}`}
                onChange={(event) =>
                  props.onParticipantVolumeChange(
                    person.id,
                    Number(event.target.value) / 100
                  )
                }
              />
            </label>
          )}
          {health && (
            <p
              className="people-connection"
              title={formatPeerBandwidthHealthTitle(health)}
            >
              Connection:{' '}
              {health.quality === 'good'
                ? 'good'
                : health.quality === 'fair'
                  ? 'fair'
                  : health.quality === 'poor'
                    ? 'poor'
                    : 'checking'}
            </p>
          )}
          <div className="people-actions">
            {canMix && (
              <button
                type="button"
                onClick={() => {
                  props.onSpotlightParticipant(spotlight ? null : person.id);
                  close();
                }}
              >
                {spotlight ? 'Clear spotlight' : 'Spotlight'}
              </button>
            )}
            {!isMe && (
              <button
                type="button"
                onClick={() => {
                  close();
                  props.onMessageParticipant(person.id);
                }}
              >
                Message privately
              </button>
            )}
            {uploadControllable && upload && (
              <button
                type="button"
                title={
                  upload.status === 'paused'
                    ? 'Continue sending this recording to the cloud'
                    : 'Free this guest’s bandwidth; the upload finishes after recording'
                }
                onClick={() => {
                  props.onRecordingUploadControl?.(
                    person.id,
                    upload.status === 'paused' ? 'resume' : 'pause'
                  );
                  close();
                }}
              >
                {upload.status === 'paused' ? 'Resume upload' : 'Pause upload'}
              </button>
            )}
            {manageable && (
              <>
                {person.status !== 'on-stage' && (
                  <button type="button" onClick={() => action('notify-next')}>
                    Notify: you’re next
                  </button>
                )}
                {person.status === 'on-stage' && (
                  <button
                    type="button"
                    onClick={() => action('move-to-backstage')}
                  >
                    Move backstage
                  </button>
                )}
                {person.status !== 'green-room' && (
                  <button
                    type="button"
                    onClick={() => action('move-to-green-room')}
                  >
                    Move to waiting room
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    action(
                      person.role === 'co-host'
                        ? 'demote-to-guest'
                        : 'promote-co-host'
                    )
                  }
                >
                  {person.role === 'co-host' ? 'Make guest' : 'Make co-host'}
                </button>
                <button
                  type="button"
                  className="people-danger"
                  onClick={() => setConfirmAction('remove')}
                >
                  Remove
                </button>
                <button
                  type="button"
                  className="people-danger"
                  onClick={() => setConfirmAction('ban')}
                >
                  Ban from studio
                </button>
              </>
            )}
          </div>
          {confirmAction && manageable && (
            <div className="people-confirm">
              <p>
                {confirmAction === 'ban'
                  ? `Ban ${person.name} from this studio?`
                  : `Remove ${person.name} from this session?`}
              </p>
              <div>
                <button
                  type="button"
                  className="people-danger"
                  onClick={() => action(confirmAction)}
                >
                  {confirmAction === 'ban' ? 'Confirm ban' : 'Confirm removal'}
                </button>
                <button type="button" onClick={() => setConfirmAction(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PersonPreview({
  stream,
  enabled,
  name,
}: {
  stream: MediaStream | null;
  enabled: boolean;
  name: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream || !enabled) return;
    video.srcObject = stream;
    void video.play().catch(() => {});
    return () => {
      video.srcObject = null;
    };
  }, [stream, enabled]);
  return (
    <div className="people-preview" aria-hidden="true">
      {enabled && stream ? (
        <video ref={videoRef} autoPlay playsInline muted />
      ) : (
        <span>{(name || '?').charAt(0).toUpperCase()}</span>
      )}
    </div>
  );
}
