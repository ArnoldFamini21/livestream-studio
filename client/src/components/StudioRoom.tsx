import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { SignalMessage, Participant, Room, LayoutMode, ChatMessage, StreamDestination, StageActionPayload } from '@studio/shared';
import { useSignaling } from '../hooks/useSignaling.ts';
import { useMediaDevices } from '../hooks/useMediaDevices.ts';
import { useWebRTC } from '../hooks/useWebRTC.ts';
import { useRecording } from '../hooks/useRecording.ts';
import { useScreenShare } from '../hooks/useScreenShare.ts';
import { VideoTile } from './VideoTile.tsx';
import { ControlBar } from './ControlBar.tsx';
import { DeviceSelector } from './DeviceSelector.tsx';
import { Sidebar } from './Sidebar.tsx';
import { ChatPanel } from './ChatPanel.tsx';
import { LowerThirdOverlay, type LowerThirdData } from './LowerThird.tsx';
import { ParticipantManager } from './ParticipantManager.tsx';
import { StreamDestinations } from './StreamDestinations.tsx';
import { MediaPanel } from './MediaPanel.tsx';
import { SoundBoard } from './SoundBoard.tsx';
import { Teleprompter } from './Teleprompter.tsx';
import { BannerOverlayDisplay, type BannerData } from './BannerOverlay.tsx';
import { TimerOverlayDisplay, useTimerTick, type TimerData } from './TimerOverlay.tsx';
import { BackgroundMusic } from './BackgroundMusic.tsx';

export function StudioRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const userName = sessionStorage.getItem('userName') || 'Anonymous';
  const userRole = (sessionStorage.getItem('userRole') || 'guest') as 'host' | 'guest';

  const [room, setRoom] = useState<Room | null>(null);
  const [myParticipant, setMyParticipant] = useState<Participant | null>(null);
  const [participants, setParticipants] = useState<Map<string, Participant>>(new Map());
  const [joined, setJoined] = useState(false);

  // UI panels
  const [showDeviceSettings, setShowDeviceSettings] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showParticipants, setShowParticipants] = useState(false);
  const [showStreamDest, setShowStreamDest] = useState(false);
  const [showMediaPanel, setShowMediaPanel] = useState(false);
  const [showSoundBoard, setShowSoundBoard] = useState(false);
  const [showTeleprompter, setShowTeleprompter] = useState(false);
  const [showBackgroundMusic, setShowBackgroundMusic] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  // Layout
  const [layout, setLayout] = useState<LayoutMode>('grid');

  // Lower thirds
  const [lowerThirds, setLowerThirds] = useState<LowerThirdData[]>([]);

  // Banners
  const [banners, setBanners] = useState<BannerData[]>([]);

  // Timers
  const [timers, setTimers] = useState<TimerData[]>([]);

  // Stream destinations
  const [destinations, setDestinations] = useState<StreamDestination[]>([]);
  const [isLive, setIsLive] = useState(false);

  // Media overlay
  const [activeMedia, setActiveMedia] = useState<{ type: 'video' | 'image' | 'pdf'; url: string } | null>(null);

  // Hooks
  const { connect, send, addHandler, connected } = useSignaling();
  const {
    localStream, audioEnabled, videoEnabled,
    startMedia, stopMedia, toggleAudio, toggleVideo,
    switchAudioDevice, switchVideoDevice,
    audioDevices, videoDevices, audioOutputDevices,
    selectedAudioDeviceId, selectedVideoDeviceId,
    selectedAudioOutputDeviceId, setSelectedAudioOutputDeviceId,
  } = useMediaDevices();

  const { remoteStreams, connectToPeer, handleOffer, handleAnswer, handleIceCandidate, removePeer, replaceTrack, cleanup } = useWebRTC({
    localStream,
    myParticipantId: myParticipant?.id || null,
    send,
  });

  const { isRecording, formattedTime, startRecording, downloadRecordings } = useRecording();
  const { isScreenSharing, startScreenShare, stopScreenShare } = useScreenShare();

  const joinedRef = useRef(false);
  const myParticipantRef = useRef<Participant | null>(null);
  const idCounters = useRef({ lt: 0, dest: 0, banner: 0, timer: 0 });

  // Keep ref in sync with state
  useEffect(() => {
    myParticipantRef.current = myParticipant;
  }, [myParticipant]);

  // Connect WebSocket and start media on mount
  useEffect(() => {
    connect();
    startMedia();
  }, [connect, startMedia]);

  // Join room once connected
  useEffect(() => {
    if (connected && localStream && roomId && !joinedRef.current) {
      joinedRef.current = true;
      send({
        type: 'join-room',
        payload: { roomId, name: userName, role: userRole },
      });
    }
  }, [connected, localStream, roomId, userName, userRole, send]);

  // Signaling message handler
  const handleSignalingMessage = useCallback(
    (message: SignalMessage) => {
      switch (message.type) {
        case 'room-joined': {
          const { room: roomData, participant, participants: existing } = message.payload;
          setRoom(roomData);
          setMyParticipant(participant);
          setJoined(true);
          const map = new Map<string, Participant>();
          existing.forEach((p) => map.set(p.id, p));
          setParticipants(map);
          existing.forEach((p) => {
            setTimeout(() => connectToPeer(p.id), 100);
          });
          break;
        }
        case 'participant-joined': {
          setParticipants((prev) => {
            const next = new Map(prev);
            next.set(message.payload.id, message.payload);
            return next;
          });
          break;
        }
        case 'participant-left': {
          const { participantId } = message.payload;
          setParticipants((prev) => { const n = new Map(prev); n.delete(participantId); return n; });
          removePeer(participantId);
          break;
        }
        case 'participant-updated': {
          const updated = message.payload;
          setParticipants((prev) => {
            const next = new Map(prev);
            if (next.has(updated.id)) {
              next.set(updated.id, updated);
            }
            return next;
          });
          // Update self if it's our participant (use ref to avoid stale closure)
          if (myParticipantRef.current && updated.id === myParticipantRef.current.id) {
            setMyParticipant(updated);
          }
          break;
        }
        case 'offer':
          handleOffer(message.payload.from, message.payload.sdp);
          break;
        case 'answer':
          handleAnswer(message.payload.from, message.payload.sdp);
          break;
        case 'ice-candidate':
          handleIceCandidate(message.payload.from, message.payload.candidate);
          break;
        case 'media-state-changed': {
          const { participantId, audioEnabled: a, videoEnabled: v, screenSharing: s } = message.payload;
          setParticipants((prev) => {
            const next = new Map(prev);
            const e = next.get(participantId);
            if (e) next.set(participantId, { ...e, audioEnabled: a, videoEnabled: v, screenSharing: s });
            return next;
          });
          break;
        }
        case 'chat-message':
          setChatMessages((prev) => [...prev, message.payload]);
          break;
        case 'error':
          console.error('Server error:', message.payload.message);
          if (message.payload.code === 'ROOM_NOT_FOUND') { alert('Room not found'); navigate('/'); }
          break;
      }
    },
    [connectToPeer, handleOffer, handleAnswer, handleIceCandidate, removePeer, navigate]
  );

  useEffect(() => {
    const rm = addHandler(handleSignalingMessage);
    return rm;
  }, [addHandler, handleSignalingMessage]);

  // ====== Actions ======

  const onToggleAudio = () => {
    const s = toggleAudio();
    if (myParticipant) send({ type: 'media-state-changed', payload: { participantId: myParticipant.id, audioEnabled: s, videoEnabled, screenSharing: isScreenSharing } });
  };
  const onToggleVideo = () => {
    const s = toggleVideo();
    if (myParticipant) send({ type: 'media-state-changed', payload: { participantId: myParticipant.id, audioEnabled, videoEnabled: s, screenSharing: isScreenSharing } });
  };
  const onLeave = () => { cleanup(); stopMedia(); stopScreenShare(); navigate('/'); };

  const onAudioDeviceChange = async (id: string) => {
    try { const t = await switchAudioDevice(id); if (t) await replaceTrack(t); }
    catch (err) { console.error('Failed to switch audio device:', err); }
  };
  const onVideoDeviceChange = async (id: string) => {
    try { const t = await switchVideoDevice(id); if (t) await replaceTrack(t); }
    catch (err) { console.error('Failed to switch video device:', err); }
  };
  const onAudioOutputDeviceChange = (id: string) => { setSelectedAudioOutputDeviceId(id); };

  // Screen sharing
  const onToggleScreenShare = async () => {
    if (isScreenSharing) {
      stopScreenShare();
      if (myParticipant) send({ type: 'media-state-changed', payload: { participantId: myParticipant.id, audioEnabled, videoEnabled, screenSharing: false } });
    } else {
      try {
        const stream = await startScreenShare();
        if (stream && myParticipant) {
          send({ type: 'media-state-changed', payload: { participantId: myParticipant.id, audioEnabled, videoEnabled, screenSharing: true } });
        }
      } catch (err) {
        // User cancelled screen share dialog or permission denied
        console.warn('Screen share cancelled or failed:', err);
      }
    }
  };

  // Recording
  const onToggleRecording = () => {
    if (isRecording) {
      downloadRecordings();
    } else {
      const streams = new Map<string, { stream: MediaStream; name: string; isLocal: boolean }>();
      if (localStream && myParticipant) {
        streams.set(myParticipant.id, { stream: localStream, name: myParticipant.name, isLocal: true });
      }
      for (const [id, participant] of participants) {
        const rs = remoteStreams.get(id);
        if (rs) streams.set(id, { stream: rs, name: participant.name, isLocal: false });
      }
      startRecording(streams);
    }
  };

  // Chat
  const onSendChat = (content: string) => {
    if (!myParticipant) return;
    const msg: ChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      senderId: myParticipant.id,
      senderName: myParticipant.name,
      content,
      timestamp: new Date().toISOString(),
      isBackstage: false,
    };
    setChatMessages((prev) => [...prev, msg]);
    send({ type: 'chat-message', payload: msg });
  };

  // Lower thirds
  const onAddLowerThird = (lt: Omit<LowerThirdData, 'id' | 'visible'>) => {
    setLowerThirds((prev) => [...prev, { ...lt, id: `lt-${++idCounters.current.lt}`, visible: false }]);
  };
  const onToggleLowerThird = (id: string) => {
    setLowerThirds((prev) => prev.map((lt) => ({ ...lt, visible: lt.id === id ? !lt.visible : lt.visible })));
  };
  const onRemoveLowerThird = (id: string) => {
    setLowerThirds((prev) => prev.filter((lt) => lt.id !== id));
  };

  // Banners
  const onAddBanner = (banner: Omit<BannerData, 'id' | 'visible'>) => {
    setBanners((prev) => [...prev, { ...banner, id: `banner-${++idCounters.current.banner}`, visible: false }]);
  };
  const onToggleBanner = (id: string) => {
    setBanners((prev) => prev.map((b) => ({ ...b, visible: b.id === id ? !b.visible : b.visible })));
  };
  const onRemoveBanner = (id: string) => {
    setBanners((prev) => prev.filter((b) => b.id !== id));
  };

  // Timers
  const onAddTimer = (timer: Omit<TimerData, 'id' | 'visible'>) => {
    setTimers((prev) => [...prev, { ...timer, id: `timer-${++idCounters.current.timer}`, visible: false }]);
  };
  const onToggleTimer = (id: string) => {
    setTimers((prev) => prev.map((t) => ({ ...t, visible: t.id === id ? !t.visible : t.visible })));
  };
  const onRemoveTimer = (id: string) => {
    setTimers((prev) => prev.filter((t) => t.id !== id));
  };
  const onUpdateTimer = (id: string, updates: Partial<TimerData>) => {
    setTimers((prev) => prev.map((t) => t.id === id ? { ...t, ...updates } : t));
  };

  // Timer ticking
  useTimerTick(timers, onUpdateTimer);

  // Stream destinations
  const onAddDestination = (dest: Omit<StreamDestination, 'id' | 'status'>) => {
    setDestinations((prev) => [...prev, { ...dest, id: `dest-${++idCounters.current.dest}`, status: 'idle' }]);
  };
  const onRemoveDestination = (id: string) => {
    setDestinations((prev) => prev.filter((d) => d.id !== id));
  };
  const onToggleDestination = (id: string) => {
    setDestinations((prev) => prev.map((d) => d.id === id ? { ...d, enabled: !d.enabled } : d));
  };
  const onGoLive = () => {
    setIsLive(true);
    setDestinations((prev) => prev.map((d) => d.enabled ? { ...d, status: 'live' } : d));
  };
  const onStopLive = () => {
    setIsLive(false);
    setDestinations((prev) => prev.map((d) => ({ ...d, status: 'idle' })));
  };

  // Stage actions (participant management)
  const onStageAction = (action: StageActionPayload['action'], targetId: string) => {
    if (!myParticipant) return;
    send({
      type: 'stage-action',
      payload: {
        action,
        targetParticipantId: targetId,
        performedBy: myParticipant.id,
      },
    });
  };

  // Media panel
  const onPlayVideo = (url: string) => setActiveMedia({ type: 'video', url });
  const onShowImage = (url: string) => setActiveMedia({ type: 'image', url });
  const onStopMedia = () => setActiveMedia(null);

  // Build video items (only show on-stage participants) - memoized
  const videoItems = useMemo(() => {
    const items: Array<{ id: string; name: string; stream: MediaStream | null; isLocal: boolean; audioEnabled: boolean; videoEnabled: boolean }> = [];
    if (myParticipant) {
      items.push({ id: myParticipant.id, name: myParticipant.name, stream: localStream, isLocal: true, audioEnabled, videoEnabled });
    }
    for (const [id, p] of participants) {
      if (p.status === 'on-stage') {
        items.push({ id, name: p.name, stream: remoteStreams.get(id) || null, isLocal: false, audioEnabled: p.audioEnabled, videoEnabled: p.videoEnabled });
      }
    }
    return items;
  }, [myParticipant, participants, localStream, audioEnabled, videoEnabled, remoteStreams]);

  // All participants for the manager - memoized
  const allParticipantsMap = useMemo(() => {
    const map = new Map<string, Participant>();
    if (myParticipant) map.set(myParticipant.id, myParticipant);
    for (const [id, p] of participants) {
      map.set(id, p);
    }
    return map;
  }, [myParticipant, participants]);

  // Layout logic - memoized
  const gridStyle = useMemo((): React.CSSProperties => {
    const count = videoItems.length;
    switch (layout) {
      case 'spotlight':
        return { gridTemplateColumns: '1fr', gridTemplateRows: count > 1 ? '3fr auto' : '1fr' };
      case 'side-by-side':
        return { gridTemplateColumns: count >= 2 ? '1fr 1fr' : '1fr' };
      case 'pip':
        return { gridTemplateColumns: '1fr', position: 'relative' as const };
      case 'grid':
      default: {
        const cols = count <= 1 ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : 4;
        return { gridTemplateColumns: `repeat(${cols}, 1fr)` };
      }
    }
  }, [layout, videoItems.length]);

  // Loading
  if (!joined) {
    return (
      <div style={styles.loading}>
        <div style={styles.spinner} />
        <p style={styles.loadingText}>Joining studio...</p>
      </div>
    );
  }

  const visibleLowerThird = lowerThirds.find((lt) => lt.visible);
  const isHostOrCoHost = myParticipant?.role === 'host' || myParticipant?.role === 'co-host';

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.logoMark}>
            <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="7" fill="url(#g2)" />
              <circle cx="16" cy="16" r="4" fill="white" />
              <defs><linearGradient id="g2" x1="0" y1="0" x2="32" y2="32"><stop stopColor="#7c3aed" /><stop offset="1" stopColor="#a78bfa" /></linearGradient></defs>
            </svg>
          </div>
          <h2 style={styles.roomTitle}>{room?.name || 'Studio'}</h2>
          <div style={styles.divider} />
          <span style={styles.badge}>
            <span style={styles.badgeDot} />
            {videoItems.length} in studio
          </span>
          {isRecording && (
            <span style={styles.recBadge}>
              <span style={styles.recDot} />
              REC {formattedTime}
            </span>
          )}
          {isLive && (
            <span style={styles.liveBadge}>
              <span style={styles.liveBadgeDot} />
              LIVE
            </span>
          )}
          {myParticipant && (
            <span style={styles.roleBadge}>{myParticipant.role}</span>
          )}
        </div>
        <div style={styles.headerRight}>
          <button
            style={{ ...styles.headerBtn, ...(showChat ? styles.headerBtnActive : {}) }}
            onClick={() => setShowChat(!showChat)}
            aria-label="Toggle chat panel"
            aria-pressed={showChat}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          <button
            style={{ ...styles.headerBtn, ...(showSidebar ? styles.headerBtnActive : {}) }}
            onClick={() => setShowSidebar(!showSidebar)}
            aria-label="Toggle sidebar"
            aria-pressed={showSidebar}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
          <span style={styles.roomIdBadge}>{roomId}</span>
        </div>
      </div>

      {/* Main Area */}
      <div style={styles.main}>
        {/* Chat Panel (left) */}
        {showChat && (
          <ChatPanel
            messages={chatMessages}
            onSend={onSendChat}
            onClose={() => setShowChat(false)}
            senderName={userName}
          />
        )}

        {/* Stage */}
        <div style={styles.stage}>
          {/* Screen share overlay */}
          {isScreenSharing && (
            <div style={styles.screenShareBanner}>
              <span style={styles.screenShareDot} />
              You are sharing your screen
              <button style={styles.screenShareStopBtn} onClick={onToggleScreenShare} aria-label="Stop screen sharing">Stop Sharing</button>
            </div>
          )}

          <div style={{ ...styles.grid, ...gridStyle, position: 'relative' }}>
            {layout === 'spotlight' && videoItems.length > 1 ? (
              <>
                <VideoTile
                  stream={videoItems[0].stream}
                  name={videoItems[0].name}
                  isLocal={videoItems[0].isLocal}
                  audioEnabled={videoItems[0].audioEnabled}
                  videoEnabled={videoItems[0].videoEnabled}
                />
                <div style={styles.spotlightRow}>
                  {videoItems.slice(1).map((item) => (
                    <div key={item.id} style={styles.spotlightThumb}>
                      <VideoTile
                        stream={item.stream}
                        name={item.name}
                        isLocal={item.isLocal}
                        audioEnabled={item.audioEnabled}
                        videoEnabled={item.videoEnabled}
                      />
                    </div>
                  ))}
                </div>
              </>
            ) : layout === 'pip' && videoItems.length >= 2 ? (
              <>
                <VideoTile
                  stream={videoItems[0].stream}
                  name={videoItems[0].name}
                  isLocal={videoItems[0].isLocal}
                  audioEnabled={videoItems[0].audioEnabled}
                  videoEnabled={videoItems[0].videoEnabled}
                />
                <div style={styles.pipOverlay}>
                  <VideoTile
                    stream={videoItems[1].stream}
                    name={videoItems[1].name}
                    isLocal={videoItems[1].isLocal}
                    audioEnabled={videoItems[1].audioEnabled}
                    videoEnabled={videoItems[1].videoEnabled}
                  />
                </div>
              </>
            ) : (
              videoItems.map((item) => (
                <VideoTile
                  key={item.id}
                  stream={item.stream}
                  name={item.name}
                  isLocal={item.isLocal}
                  audioEnabled={item.audioEnabled}
                  videoEnabled={item.videoEnabled}
                />
              ))
            )}

            {/* Media overlay on stage */}
            {activeMedia && (
              <div style={styles.mediaOverlay}>
                {activeMedia.type === 'video' ? (
                  <video src={activeMedia.url} style={styles.mediaContent} autoPlay controls />
                ) : activeMedia.type === 'image' ? (
                  <img src={activeMedia.url} alt="Media" style={styles.mediaContent} />
                ) : (
                  <iframe src={activeMedia.url} style={styles.mediaContent} title="PDF" />
                )}
                <button style={styles.mediaCloseBtn} onClick={onStopMedia} aria-label="Close media overlay">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            )}

            {/* Lower Third Overlay */}
            {visibleLowerThird && <LowerThirdOverlay data={visibleLowerThird} />}

            {/* Banner Overlays */}
            {banners.filter((b) => b.visible).map((b) => (
              <BannerOverlayDisplay key={b.id} data={b} />
            ))}

            {/* Timer Overlays */}
            {timers.filter((t) => t.visible).map((t) => (
              <TimerOverlayDisplay key={t.id} data={t} />
            ))}
          </div>

          {/* Teleprompter overlay */}
          {showTeleprompter && (
            <Teleprompter onClose={() => setShowTeleprompter(false)} />
          )}
        </div>

        {/* Participant Manager Panel */}
        {showParticipants && (
          <ParticipantManager
            participants={allParticipantsMap}
            myParticipantId={myParticipant?.id || ''}
            myRole={myParticipant?.role || 'guest'}
            onStageAction={onStageAction}
            onClose={() => setShowParticipants(false)}
          />
        )}

        {/* Stream Destinations Panel */}
        {showStreamDest && (
          <StreamDestinations
            destinations={destinations}
            onAdd={onAddDestination}
            onRemove={onRemoveDestination}
            onToggle={onToggleDestination}
            isLive={isLive}
            onGoLive={onGoLive}
            onStopLive={onStopLive}
            onClose={() => setShowStreamDest(false)}
          />
        )}

        {/* Media Panel */}
        {showMediaPanel && (
          <MediaPanel
            onPlayVideo={onPlayVideo}
            onShowImage={onShowImage}
            onStopMedia={onStopMedia}
            activeMedia={activeMedia}
            onClose={() => setShowMediaPanel(false)}
          />
        )}

        {/* Sidebar (right) */}
        {showSidebar && (
          <Sidebar
            currentLayout={layout}
            onLayoutChange={setLayout}
            participantCount={videoItems.length}
            lowerThirds={lowerThirds}
            onAddLowerThird={onAddLowerThird}
            onToggleLowerThird={onToggleLowerThird}
            onRemoveLowerThird={onRemoveLowerThird}
            banners={banners}
            onAddBanner={onAddBanner}
            onToggleBanner={onToggleBanner}
            onRemoveBanner={onRemoveBanner}
            timers={timers}
            onAddTimer={onAddTimer}
            onToggleTimer={onToggleTimer}
            onRemoveTimer={onRemoveTimer}
            onUpdateTimer={onUpdateTimer}
          />
        )}
      </div>

      {/* Control Bar */}
      <ControlBar
        audioEnabled={audioEnabled}
        videoEnabled={videoEnabled}
        onToggleAudio={onToggleAudio}
        onToggleVideo={onToggleVideo}
        onLeave={onLeave}
        onOpenDeviceSettings={() => setShowDeviceSettings(true)}
        roomId={roomId || ''}
        isHost={isHostOrCoHost}
        isRecording={isRecording}
        formattedTime={formattedTime}
        onToggleRecording={onToggleRecording}
        isScreenSharing={isScreenSharing}
        onToggleScreenShare={onToggleScreenShare}
        onOpenParticipants={() => setShowParticipants(!showParticipants)}
        onOpenStreamDestinations={() => setShowStreamDest(!showStreamDest)}
        onOpenSoundBoard={() => setShowSoundBoard(!showSoundBoard)}
        onOpenTeleprompter={() => setShowTeleprompter(!showTeleprompter)}
        onOpenMediaPanel={() => setShowMediaPanel(!showMediaPanel)}
        onOpenBackgroundMusic={() => setShowBackgroundMusic(!showBackgroundMusic)}
        participantCount={allParticipantsMap.size}
        isLive={isLive}
      />

      {/* Sound Board Modal */}
      {showSoundBoard && <SoundBoard onClose={() => setShowSoundBoard(false)} />}

      {/* Background Music Modal */}
      {showBackgroundMusic && <BackgroundMusic onClose={() => setShowBackgroundMusic(false)} />}

      {/* Device Settings Modal */}
      {showDeviceSettings && (
        <DeviceSelector
          audioDevices={audioDevices}
          videoDevices={videoDevices}
          audioOutputDevices={audioOutputDevices}
          selectedAudioDeviceId={selectedAudioDeviceId}
          selectedVideoDeviceId={selectedVideoDeviceId}
          selectedAudioOutputDeviceId={selectedAudioOutputDeviceId}
          onAudioDeviceChange={onAudioDeviceChange}
          onVideoDeviceChange={onVideoDeviceChange}
          onAudioOutputDeviceChange={onAudioOutputDeviceChange}
          onClose={() => setShowDeviceSettings(false)}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--bg-primary)',
  },
  loading: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: 16,
  },
  loadingText: { color: 'var(--text-secondary)', fontSize: 14 },
  spinner: {
    width: 36, height: 36,
    border: '2.5px solid var(--border)',
    borderTopColor: 'var(--accent)',
    borderRadius: '50%',
    animation: 'spin 0.7s linear infinite',
  },
  // Header
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 16px',
    background: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 10 },
  logoMark: { display: 'flex' },
  headerRight: { display: 'flex', alignItems: 'center', gap: 6 },
  roomTitle: { fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' },
  divider: { width: 1, height: 16, background: 'var(--border-strong)' },
  badge: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 12, padding: '3px 10px', borderRadius: 20,
    background: 'var(--success-subtle)', color: 'var(--success)', fontWeight: 500,
  },
  badgeDot: { width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', animation: 'pulse 2s infinite' },
  recBadge: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 20,
    background: 'rgba(239, 68, 68, 0.12)', color: 'var(--danger, #ef4444)',
    fontFamily: 'monospace',
  },
  recDot: {
    width: 8, height: 8, borderRadius: '50%', background: 'var(--danger, #ef4444)',
    animation: 'livePulse 1.5s infinite',
  },
  liveBadge: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 11, fontWeight: 700, padding: '3px 12px', borderRadius: 20,
    background: '#ef4444', color: 'white',
    textTransform: 'uppercase' as const, letterSpacing: '0.05em',
  },
  liveBadgeDot: {
    width: 6, height: 6, borderRadius: '50%', background: 'white',
    animation: 'pulse 1.5s infinite',
  },
  roleBadge: {
    fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
    background: 'var(--accent-subtle)', color: 'var(--accent)',
    textTransform: 'uppercase' as const, letterSpacing: '0.04em',
  },
  headerBtn: {
    width: 32, height: 32, borderRadius: 8,
    background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
    color: 'var(--text-secondary)', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 0, transition: 'all var(--transition-fast)',
  },
  headerBtnActive: {
    background: 'var(--accent-subtle)',
    borderColor: 'var(--accent)',
    color: 'var(--accent)',
  },
  roomIdBadge: {
    fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace',
    padding: '4px 8px', borderRadius: 6, background: 'var(--bg-tertiary)',
  },
  // Main
  main: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
  },
  stage: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    overflow: 'hidden',
    position: 'relative',
  },
  grid: {
    display: 'grid',
    gap: 8,
    width: '100%',
    maxWidth: 1200,
    maxHeight: '100%',
    flex: 1,
    transition: 'all var(--transition-slow)',
  },
  // Spotlight layout
  spotlightRow: {
    display: 'flex',
    gap: 8,
    height: 120,
  },
  spotlightThumb: {
    flex: 1,
    minWidth: 0,
  },
  // PiP layout
  pipOverlay: {
    position: 'absolute',
    bottom: 16,
    right: 16,
    width: '22%',
    minWidth: 160,
    borderRadius: 'var(--radius)',
    overflow: 'hidden',
    boxShadow: 'var(--shadow-lg)',
    border: '2px solid var(--border)',
    zIndex: 5,
  },
  // Screen share banner
  screenShareBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 16px',
    background: 'rgba(34, 197, 94, 0.12)',
    border: '1px solid rgba(34, 197, 94, 0.25)',
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 500,
    color: '#22c55e',
    marginBottom: 8,
    alignSelf: 'stretch',
  },
  screenShareDot: {
    width: 6, height: 6, borderRadius: '50%', background: '#22c55e',
    animation: 'pulse 2s infinite',
  },
  screenShareStopBtn: {
    marginLeft: 'auto',
    padding: '3px 10px',
    fontSize: 11,
    fontWeight: 600,
    background: '#ef4444',
    color: 'white',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
  },
  // Media overlay
  mediaOverlay: {
    position: 'absolute',
    inset: 8,
    background: '#000',
    borderRadius: 'var(--radius-lg)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    overflow: 'hidden',
  },
  mediaContent: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    border: 'none',
  },
  mediaCloseBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 32,
    height: 32,
    borderRadius: 8,
    background: 'rgba(0,0,0,0.6)',
    border: '1px solid rgba(255,255,255,0.15)',
    color: 'white',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    zIndex: 11,
  },
};
