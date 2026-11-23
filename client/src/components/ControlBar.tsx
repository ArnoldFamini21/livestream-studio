import { useEffect, useRef, useState } from 'react';
import { StudioIcon } from './StudioIcon.tsx';
import { StudioToolMenu, type StudioTool } from './StudioToolMenu.tsx';
import { withShortcutHint } from '../utils/keyboardShortcuts.ts';
import { formatUnreadBadge } from '../utils/chatUnread.ts';

interface ControlBarProps {
  audioEnabled: boolean;
  videoEnabled: boolean;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onLeave: () => void;
  onOpenDeviceSettings: () => void;
  isHost: boolean;
  isRecording?: boolean;
  recordingPaused?: boolean;
  recordingFinalizing?: boolean;
  onToggleRecording?: () => void;
  onToggleRecordingPause?: () => void;
  isScreenSharing?: boolean;
  onToggleScreenShare?: () => void;
  screenShareOptimizeFor?: 'text' | 'motion';
  onScreenShareOptimizeForChange?: (mode: 'text' | 'motion') => void;
  onOpenParticipants?: () => void;
  waitingCount?: number;
  onOpenInvitePanel?: () => void;
  onOpenStreamDestinations?: () => void;
  onOpenSoundBoard?: () => void;
  onOpenTeleprompter?: () => void;
  onOpenMediaPanel?: () => void;
  onOpenOverlays?: () => void;
  onOpenBrand?: () => void;
  onOpenScenes?: () => void;
  onOpenBackgroundMusic?: () => void;
  backgroundMusicPlaying?: boolean;
  onOpenRecordingPanel?: () => void;
  onFinishGuestUpload?: () => void;
  onOpenProducerPanel?: () => void;
  onOpenWebinarQA?: () => void;
  onOpenPolls?: () => void;
  onOpenCaptions?: () => void;
  onOpenHealthPanel?: () => void;
  onOpenChat?: () => void;
  unreadChatCount?: number;
  isLive?: boolean;
  isTestStream?: boolean;
  captionsActive?: boolean;
  talkbackActive?: boolean;
  onToggleTalkback?: () => void;
}

export function ControlBar({
  audioEnabled,
  videoEnabled,
  onToggleAudio,
  onToggleVideo,
  onLeave,
  onOpenDeviceSettings,
  isHost,
  isRecording = false,
  recordingPaused = false,
  recordingFinalizing = false,
  onToggleRecording,
  onToggleRecordingPause,
  isScreenSharing = false,
  onToggleScreenShare,
  screenShareOptimizeFor = 'text',
  onScreenShareOptimizeForChange,
  onOpenParticipants,
  waitingCount = 0,
  onOpenInvitePanel,
  onOpenStreamDestinations,
  onOpenSoundBoard,
  onOpenTeleprompter,
  onOpenMediaPanel,
  onOpenOverlays,
  onOpenBrand,
  onOpenScenes,
  onOpenBackgroundMusic,
  backgroundMusicPlaying = false,
  onOpenRecordingPanel,
  onFinishGuestUpload,
  onOpenProducerPanel,
  onOpenWebinarQA,
  onOpenPolls,
  onOpenCaptions,
  onOpenHealthPanel,
  onOpenChat,
  unreadChatCount = 0,
  isLive = false,
  isTestStream = false,
  captionsActive = false,
  talkbackActive = false,
  onToggleTalkback,
}: ControlBarProps) {
  const [showMore, setShowMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!showMore) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !moreRef.current?.contains(event.target)) {
        setShowMore(false);
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [showMore]);

  const dismissTools = () => {
    setShowMore(false);
    moreButtonRef.current?.focus();
  };

  const items: StudioTool[] = [];
  const addTool = (group: StudioTool['group'], label: string, onClick?: () => void, keywords?: string) => {
    if (onClick) items.push({ group, label, onClick, keywords });
  };
  addTool('Production', 'Invite guests', onOpenInvitePanel, 'link qr code copy share');
  addTool('Production', 'Media', onOpenMediaPanel, 'slides presentation video files');
  addTool('Production', 'Overlays', onOpenOverlays, 'banner lower thirds graphics');
  addTool('Production', 'Scenes', onOpenScenes, 'presets show layouts');
  addTool('Production', 'Brand', onOpenBrand, 'logo kit background');
  addTool('Production', 'Teleprompter', onOpenTeleprompter, 'script notes');
  addTool('Production', 'Producer', onOpenProducerPanel, 'rundown');
  addTool('Production', 'Recordings', onOpenRecordingPanel, 'capture tracks export');
  addTool('Production', 'Finish upload', onFinishGuestUpload, 'recording recover backup');
  if (isRecording) {
    addTool('Production', recordingPaused ? 'Resume recording' : 'Pause recording', onToggleRecordingPause);
  }
  if (isHost) {
    addTool('Audience', unreadChatCount > 0 ? 'Chat · ' + formatUnreadBadge(unreadChatCount) + ' unread' : 'Chat', onOpenChat, 'messages');
  }
  addTool('Audience', 'Q&A', onOpenWebinarQA, 'questions answers');
  addTool('Audience', 'Polls', onOpenPolls);
  addTool('Audience', captionsActive ? 'Captions on' : 'Captions', onOpenCaptions, 'subtitles transcript');
  addTool('Settings', 'Camera and microphone', onOpenDeviceSettings, 'audio video devices speakers');
  if (onToggleScreenShare && onScreenShareOptimizeForChange) {
    const nextMode = screenShareOptimizeFor === 'text' ? 'motion' : 'text';
    addTool('Settings', nextMode === 'motion' ? 'Share smoother motion' : 'Share sharper text',
      () => onScreenShareOptimizeForChange(nextMode), 'screen share quality optimize');
  }
  if (!talkbackActive) addTool('Settings', 'Talk backstage', onToggleTalkback, 'talkback off air microphone');
  addTool('Settings', 'Sounds', onOpenSoundBoard, 'soundboard effects');
  addTool('Settings', backgroundMusicPlaying ? 'Music playing' : 'Music', onOpenBackgroundMusic, 'background audio');
  addTool('Settings', 'Session health', onOpenHealthPanel, 'connection network diagnostics');
  if (isHost) addTool('Settings', 'End session', onLeave, 'leave studio');

  return (
    <div className="studio-control-bar" role="region" aria-label="Studio controls">
      <div className="studio-control-devices">
        <button type="button" className="studio-control" onClick={onToggleAudio}
          aria-label={audioEnabled ? 'Mute microphone' : 'Unmute microphone'}
          aria-pressed={audioEnabled} data-active={audioEnabled}
          title={withShortcutHint(audioEnabled ? 'Mute microphone' : 'Unmute microphone', 'toggle-mic')}>
          <StudioIcon name={audioEnabled ? 'mic' : 'mic-off'} />
          <span>Mic</span>
        </button>
        <button type="button" className="studio-control" onClick={onToggleVideo}
          aria-label={videoEnabled ? 'Turn camera off' : 'Turn camera on'}
          aria-pressed={videoEnabled} data-active={videoEnabled}
          title={withShortcutHint(videoEnabled ? 'Turn camera off' : 'Turn camera on', 'toggle-camera')}>
          <StudioIcon name={videoEnabled ? 'video' : 'video-off'} />
          <span>Camera</span>
        </button>
        {onToggleScreenShare && (
          <button type="button" className="studio-control" onClick={onToggleScreenShare}
            aria-label={isScreenSharing ? 'Stop sharing screen' : 'Share screen'}
            aria-pressed={isScreenSharing} data-selected={isScreenSharing}
            title={withShortcutHint(isScreenSharing ? 'Stop sharing screen' : 'Share screen', 'toggle-screen-share')}>
            <StudioIcon name="screen" />
            <span>{isScreenSharing ? 'Stop share' : 'Share'}</span>
          </button>
        )}
        {!isHost && onOpenChat && (
          <button type="button" className="studio-control" onClick={onOpenChat}
            aria-label={unreadChatCount > 0 ? 'Open chat, ' + unreadChatCount + ' unread' : 'Open chat'}>
            <StudioIcon name="chat" />
            <span>Chat</span>
            {unreadChatCount > 0 && <span className="studio-control-count" aria-hidden="true">{formatUnreadBadge(unreadChatCount)}</span>}
          </button>
        )}
        {isHost && onOpenParticipants && (
          <button type="button" className="studio-control" onClick={onOpenParticipants}
            aria-label={waitingCount ? 'People, ' + waitingCount + ' waiting' : 'People'}
            title={withShortcutHint('People', 'open-people')}>
            <StudioIcon name="team" />
            <span>People</span>
            {waitingCount > 0 && <span className="studio-control-count" aria-hidden="true">{waitingCount}</span>}
          </button>
        )}
      </div>
      <div className="studio-control-session">
        {talkbackActive && onToggleTalkback && (
          <button type="button" className="studio-control" onClick={onToggleTalkback}
            aria-label="Stop talking backstage and go back on air" title={withShortcutHint('Stop talking backstage', 'toggle-talkback')}>
            Stop talkback
          </button>
        )}
        {isHost && onToggleRecording && (
          <button type="button" className="studio-control studio-control-record" onClick={onToggleRecording}
            data-recording={isRecording} disabled={recordingFinalizing}
            aria-label={recordingFinalizing ? 'Saving recording' : isRecording ? 'Stop recording' : 'Start recording'}
            title={recordingFinalizing ? 'Saving recording' : withShortcutHint(isRecording ? 'Stop recording' : 'Start recording', 'toggle-recording')}>
            <StudioIcon name={isRecording ? 'stop' : 'record'} />
            <span>{recordingFinalizing ? 'Saving…' : isRecording ? 'Stop recording' : 'Record'}</span>
          </button>
        )}
        {isHost && onOpenStreamDestinations && (
          <button type="button" className="studio-control studio-control-live" onClick={onOpenStreamDestinations}
            data-selected={isLive || isTestStream}
            aria-label={isLive ? 'Live: open stream destinations' : isTestStream ? 'Test running, not public: open stream destinations' : 'Go live: open stream destinations'}
            title={withShortcutHint(isLive || isTestStream ? 'Stream destinations' : 'Go live', 'open-go-live')}>
            <span>{isLive || isTestStream ? 'Destinations' : 'Go live'}</span>
          </button>
        )}
        <div className="studio-control-more" ref={moreRef}>
          <button type="button" className="studio-control" ref={moreButtonRef} onClick={() => setShowMore(open => !open)}
            aria-label="More tools"
            aria-description={isHost && unreadChatCount > 0 ? `${unreadChatCount} unread chat messages` : undefined}
            aria-haspopup="dialog" aria-expanded={showMore}>
            <StudioIcon name="more" />
            <span>More</span>
            {isHost && unreadChatCount > 0 && <span className="studio-control-count" aria-hidden="true">{formatUnreadBadge(unreadChatCount)}</span>}
          </button>
          {showMore && <StudioToolMenu items={items} onDismiss={dismissTools} />}
        </div>
        {!isHost && <button type="button" className="studio-control studio-control-leave" onClick={onLeave} aria-label="Leave studio">Leave</button>}
      </div>
    </div>
  );
}
