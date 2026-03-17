import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { SignalMessage, Participant, Room, LayoutMode, ChatMessage, StreamDestination, StageActionPayload, StageBackground, Scene } from '@studio/shared';
import { useSignaling } from '../hooks/useSignaling.ts';
import { useMediaDevices } from '../hooks/useMediaDevices.ts';
import { useWebRTC } from '../hooks/useWebRTC.ts';
import { useRecording } from '../hooks/useRecording.ts';
import { useScreenShare } from '../hooks/useScreenShare.ts';
import { useLocalRecording } from '../hooks/useLocalRecording.ts';
import { VideoTile } from './VideoTile.tsx';
import { ControlBar } from './ControlBar.tsx';
import { DeviceSelector } from './DeviceSelector.tsx';
import { Sidebar } from './Sidebar.tsx';
import { ChatPanel } from './ChatPanel.tsx';
import { LowerThirdOverlay, type LowerThirdData } from './LowerThird.tsx';
import { StreamDestinations } from './StreamDestinations.tsx';
import { MediaPanel } from './MediaPanel.tsx';
import { SoundBoard } from './SoundBoard.tsx';
import { Teleprompter } from './Teleprompter.tsx';
import { BannerOverlayDisplay, type BannerData } from './BannerOverlay.tsx';
import { TimerOverlayDisplay, useTimerTick, type TimerData } from './TimerOverlay.tsx';
import { BackgroundMusic } from './BackgroundMusic.tsx';
import { RecordingPanel } from './RecordingPanel.tsx';
import { LayoutSwitcher } from './LayoutSwitcher.tsx';
import { ProducerPanel } from './ProducerPanel.tsx';
import { CommentHighlightOverlay, type HighlightedComment } from './CommentHighlight.tsx';
import { TickerOverlayDisplay, type TickerData } from './TickerOverlay.tsx';
import { WebinarQAPanel, WebinarQAOverlay, WebinarQAAudience, type QAQuestion } from './WebinarQA.tsx';

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
  const [showSidebar, setShowSidebar] = useState(true);
  const [showParticipants, setShowParticipants] = useState(false);
  const [showStreamDest, setShowStreamDest] = useState(false);
  const [showMediaPanel, setShowMediaPanel] = useState(false);
  const [showSoundBoard, setShowSoundBoard] = useState(false);
  const [showTeleprompter, setShowTeleprompter] = useState(false);
  const [showBackgroundMusic, setShowBackgroundMusic] = useState(false);
  const [showRecordingPanel, setShowRecordingPanel] = useState(false);
  const [showProducerPanel, setShowProducerPanel] = useState(false);
  const [showWebinarQA, setShowWebinarQA] = useState(false);
  const [showGuestChat, setShowGuestChat] = useState(false);
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

  // Room ending countdown
  const [roomEnding, setRoomEnding] = useState(false);
  const [endingCountdown, setEndingCountdown] = useState(10);

  // Media overlay
  const [activeMedia, setActiveMedia] = useState<{ type: 'video' | 'image' | 'pdf'; url: string } | null>(null);

  // Brand state (lifted from Sidebar so it can drive stage appearance)
  const [stageBackground, setStageBackground] = useState<StageBackground>({ type: 'none', value: '' });
  const [brandColor, setBrandColor] = useState('#a78bfa');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  // Scenes
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);

  // Comment highlighting
  const [highlightedComment, setHighlightedComment] = useState<HighlightedComment | null>(null);

  // Tickers
  const [tickers, setTickers] = useState<TickerData[]>([]);

  // Webinar Q&A
  const [qaQuestions, setQAQuestions] = useState<QAQuestion[]>([]);
  const [myUpvotes, setMyUpvotes] = useState<Set<string>>(new Set());

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
  const { screenStream, isScreenSharing, startScreenShare, stopScreenShare } = useScreenShare();
  const {
    isRecording: isLocalRecording,
    formattedTime: localRecFormattedTime,
    startRecording: startLocalRecording,
    stopRecording: stopLocalRecording,
  } = useLocalRecording();

  const joinedRef = useRef(false);
  const myParticipantRef = useRef<Participant | null>(null);
  const idCounters = useRef({ lt: 0, dest: 0, banner: 0, timer: 0, ticker: 0, qa: 0 });

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
          setChatMessages((prev) => {
            // Deduplicate: the sender already added this message optimistically
            if (prev.some((m) => m.id === message.payload.id)) return prev;
            return [...prev, message.payload];
          });
          break;
        case 'room-ending':
          setRoomEnding(true);
          setEndingCountdown(message.payload.countdown);
          break;
        case 'room-ended':
          setRoomEnding(false);
          cleanup();
          stopMedia();
          stopScreenShare();
          navigate('/');
          break;
        case 'error':
          console.error('Server error:', message.payload.message);
          if (message.payload.code === 'ROOM_NOT_FOUND') { alert('Room not found'); navigate('/'); }
          break;
      }
    },
    [connectToPeer, handleOffer, handleAnswer, handleIceCandidate, removePeer, navigate, cleanup, stopMedia, stopScreenShare]
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
  const onLeave = () => {
    if (userRole === 'host') {
      // Host ends the room: trigger server-side countdown for all participants
      send({ type: 'end-room', payload: {} });
    } else {
      // Guests just leave immediately
      cleanup(); stopMedia(); stopScreenShare(); navigate('/');
    }
  };

  const onAudioDeviceChange = async (id: string) => {
    try { const t = await switchAudioDevice(id); if (t) await replaceTrack(t); }
    catch (err) { console.error('Failed to switch audio device:', err); }
  };
  const onVideoDeviceChange = async (id: string) => {
    try { const t = await switchVideoDevice(id); if (t) await replaceTrack(t); }
    catch (err) { console.error('Failed to switch video device:', err); }
  };
  const onAudioOutputDeviceChange = (id: string) => { setSelectedAudioOutputDeviceId(id); };

  // Screen sharing — replace the camera video track on all peer connections
  // so remote participants actually receive the screen feed.
  const onToggleScreenShare = async () => {
    if (isScreenSharing) {
      stopScreenShare();
      // Restore the camera video track on all peer connections
      const cameraTrack = localStream?.getVideoTracks()[0];
      if (cameraTrack) await replaceTrack(cameraTrack);
      if (myParticipant) send({ type: 'media-state-changed', payload: { participantId: myParticipant.id, audioEnabled, videoEnabled, screenSharing: false } });
    } else {
      try {
        const stream = await startScreenShare();
        if (stream && myParticipant) {
          // Replace the camera video track with the screen video track on all peers
          const screenTrack = stream.getVideoTracks()[0];
          if (screenTrack) {
            await replaceTrack(screenTrack);
            // When the user stops sharing via the browser's native button,
            // restore the camera track automatically
            screenTrack.addEventListener('ended', async () => {
              const camTrack = localStream?.getVideoTracks()[0];
              if (camTrack) await replaceTrack(camTrack);
            });
          }
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

  // Local recording (separate tracks)
  const onStartLocalRecording = () => {
    if (localStream) {
      startLocalRecording(localStream, screenStream);
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

  // Scenes
  const onSaveScene = (name: string) => {
    const newScene: Scene = {
      id: `scene-${Date.now()}`,
      name,
      layout,
      background: stageBackground,
      brandColor,
      logoUrl,
      visibleOverlayIds: [
        ...lowerThirds.filter(lt => lt.visible).map(lt => lt.id),
        ...banners.filter(b => b.visible).map(b => b.id),
        ...timers.filter(t => t.visible).map(t => t.id),
        ...tickers.filter(t => t.visible).map(t => t.id),
      ],
    };
    setScenes(prev => [...prev, newScene]);
    setActiveSceneId(newScene.id);
  };
  const onApplyScene = (sceneId: string) => {
    const scene = scenes.find(s => s.id === sceneId);
    if (!scene) return;
    setLayout(scene.layout);
    setStageBackground(scene.background);
    setBrandColor(scene.brandColor);
    setLogoUrl(scene.logoUrl);
    setActiveSceneId(sceneId);
  };
  const onDeleteScene = (sceneId: string) => {
    setScenes(prev => prev.filter(s => s.id !== sceneId));
    if (activeSceneId === sceneId) setActiveSceneId(null);
  };
  const onRenameScene = (sceneId: string, newName: string) => {
    setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, name: newName } : s));
  };

  // Tickers
  const onAddTicker = (ticker: Omit<TickerData, 'id' | 'visible'>) => {
    setTickers(prev => [...prev, { ...ticker, id: `ticker-${++idCounters.current.ticker}`, visible: false }]);
  };
  const onToggleTicker = (id: string) => {
    setTickers(prev => prev.map(t => ({ ...t, visible: t.id === id ? !t.visible : t.visible })));
  };
  const onRemoveTicker = (id: string) => {
    setTickers(prev => prev.filter(t => t.id !== id));
  };
  const onUpdateTicker = (id: string, updates: Partial<TickerData>) => {
    setTickers(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
  };

  // Comment highlighting
  const onHighlightComment = (comment: HighlightedComment) => setHighlightedComment(comment);
  const onDismissComment = () => setHighlightedComment(null);

  // Webinar Q&A
  const onSubmitQuestion = (content: string) => {
    const question: QAQuestion = {
      id: `qa-${++idCounters.current.qa}`,
      authorName: userName,
      content,
      timestamp: new Date().toISOString(),
      upvotes: 0,
      status: 'pending',
      highlighted: false,
    };
    setQAQuestions(prev => [...prev, question]);
  };
  const onApproveQuestion = (id: string) => {
    setQAQuestions(prev => prev.map(q => q.id === id ? { ...q, status: 'approved' as const } : q));
  };
  const onDismissQuestion = (id: string) => {
    setQAQuestions(prev => prev.map(q => q.id === id ? { ...q, status: 'dismissed' as const } : q));
  };
  const onAnswerQuestion = (id: string, answer: string) => {
    setQAQuestions(prev => prev.map(q => q.id === id ? { ...q, status: 'answered' as const, answer } : q));
  };
  const onHighlightQuestion = (id: string) => {
    setQAQuestions(prev => prev.map(q => ({ ...q, highlighted: q.id === id })));
  };
  const onUnhighlightQuestion = (id: string) => {
    setQAQuestions(prev => prev.map(q => q.id === id ? { ...q, highlighted: false } : q));
  };
  const onUpvoteQuestion = (id: string) => {
    setMyUpvotes(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        setQAQuestions(p => p.map(q => q.id === id ? { ...q, upvotes: Math.max(0, q.upvotes - 1) } : q));
      } else {
        next.add(id);
        setQAQuestions(p => p.map(q => q.id === id ? { ...q, upvotes: q.upvotes + 1 } : q));
      }
      return next;
    });
  };

  // Build video items (only show on-stage participants) - memoized
  // When someone is screen sharing, the screen share replaces their camera track
  // on the WebRTC connection. Locally, we show the screen share as a separate tile.
  const videoItems = useMemo(() => {
    const items: Array<{ id: string; name: string; stream: MediaStream | null; isLocal: boolean; audioEnabled: boolean; videoEnabled: boolean; isScreenShare?: boolean }> = [];
    if (myParticipant) {
      items.push({ id: myParticipant.id, name: myParticipant.name, stream: localStream, isLocal: true, audioEnabled, videoEnabled });
      // Add local screen share as a separate tile
      if (isScreenSharing && screenStream) {
        items.push({ id: `${myParticipant.id}-screen`, name: `${myParticipant.name}'s Screen`, stream: screenStream, isLocal: true, audioEnabled: false, videoEnabled: true, isScreenShare: true });
      }
    }
    for (const [id, p] of participants) {
      if (p.status === 'on-stage') {
        items.push({ id, name: p.name, stream: remoteStreams.get(id) || null, isLocal: false, audioEnabled: p.audioEnabled, videoEnabled: p.screenSharing ? true : p.videoEnabled });
      }
    }
    return items;
  }, [myParticipant, participants, localStream, audioEnabled, videoEnabled, remoteStreams, isScreenSharing, screenStream]);

  // All participants for the manager - memoized
  const allParticipantsMap = useMemo(() => {
    const map = new Map<string, Participant>();
    if (myParticipant) map.set(myParticipant.id, myParticipant);
    for (const [id, p] of participants) {
      map.set(id, p);
    }
    return map;
  }, [myParticipant, participants]);

  // Stage background style - memoized
  const stageBackgroundStyle = useMemo((): React.CSSProperties => {
    switch (stageBackground.type) {
      case 'color':
        return { background: stageBackground.value };
      case 'gradient':
        return { background: stageBackground.value };
      case 'image':
        return {
          backgroundImage: `url(${stageBackground.value})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
        };
      case 'none':
      default:
        return {};
    }
  }, [stageBackground]);

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
      case 'single':
        return { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' };
      case 'featured':
        return { gridTemplateColumns: count >= 2 ? '2fr 1fr' : '1fr' };
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
              <defs><linearGradient id="g2" x1="0" y1="0" x2="32" y2="32"><stop stopColor="#a78bfa" /><stop offset="1" stopColor="#67e8f9" /></linearGradient></defs>
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
          {isHostOrCoHost && (
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
          )}
          <span style={styles.roomIdBadge}>{roomId}</span>
        </div>
      </div>

      {/* Main Area */}
      <div style={styles.main}>
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

          {/* Fixed 16:9 Canvas */}
          <div style={styles.canvasWrapper}>
            <div style={{ ...styles.canvas, ...stageBackgroundStyle }}>
              <div style={{ ...styles.grid, ...gridStyle, position: 'relative' }}>
                {layout === 'single' && videoItems.length > 0 ? (
                  <div style={styles.singleTile}>
                    <VideoTile
                      stream={videoItems[0].stream}
                      name={videoItems[0].name}
                      isLocal={videoItems[0].isLocal}
                      audioEnabled={videoItems[0].audioEnabled}
                      videoEnabled={videoItems[0].videoEnabled}
                      brandColor={brandColor}
                    />
                  </div>
                ) : layout === 'featured' && videoItems.length >= 2 ? (
                  <>
                    <div style={styles.featuredMain}>
                      <VideoTile
                        stream={videoItems[0].stream}
                        name={videoItems[0].name}
                        isLocal={videoItems[0].isLocal}
                        audioEnabled={videoItems[0].audioEnabled}
                        videoEnabled={videoItems[0].videoEnabled}
                        brandColor={brandColor}
                      />
                    </div>
                    <div style={styles.featuredSide}>
                      {videoItems.slice(1).map((item) => (
                        <div key={item.id} style={styles.featuredSideTile}>
                          <VideoTile
                            stream={item.stream}
                            name={item.name}
                            isLocal={item.isLocal}
                            audioEnabled={item.audioEnabled}
                            videoEnabled={item.videoEnabled}
                            brandColor={brandColor}
                          />
                        </div>
                      ))}
                    </div>
                  </>
                ) : layout === 'spotlight' && videoItems.length > 1 ? (
                  <>
                    <VideoTile
                      stream={videoItems[0].stream}
                      name={videoItems[0].name}
                      isLocal={videoItems[0].isLocal}
                      audioEnabled={videoItems[0].audioEnabled}
                      videoEnabled={videoItems[0].videoEnabled}
                      brandColor={brandColor}
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
                            brandColor={brandColor}
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
                      brandColor={brandColor}
                    />
                    <div style={styles.pipOverlay}>
                      <VideoTile
                        stream={videoItems[1].stream}
                        name={videoItems[1].name}
                        isLocal={videoItems[1].isLocal}
                        audioEnabled={videoItems[1].audioEnabled}
                        videoEnabled={videoItems[1].videoEnabled}
                        brandColor={brandColor}
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
                      brandColor={brandColor}
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

                {/* Ticker Overlays */}
                {tickers.filter((t) => t.visible).map((t) => (
                  <TickerOverlayDisplay key={t.id} data={t} />
                ))}

                {/* Comment Highlight Overlay */}
                <CommentHighlightOverlay comment={highlightedComment} />

                {/* Webinar Q&A Overlay */}
                <WebinarQAOverlay question={qaQuestions.find(q => q.highlighted) || null} />
              </div>

              {/* Logo watermark */}
              {logoUrl && (
                <div style={styles.logoWatermark}>
                  <img src={logoUrl} alt="Logo" style={styles.logoWatermarkImg} />
                </div>
              )}
            </div>
          </div>

          {/* Floating layout switcher (like StreamYard) — below canvas */}
          {isHostOrCoHost && (
            <div style={styles.layoutBar}>
              <LayoutSwitcher
                currentLayout={layout}
                onLayoutChange={setLayout}
                participantCount={videoItems.length}
              />
            </div>
          )}

          {/* Teleprompter overlay */}
          {showTeleprompter && (
            <Teleprompter onClose={() => setShowTeleprompter(false)} />
          )}
        </div>

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

        {/* Guest Chat Panel */}
        {!isHostOrCoHost && showGuestChat && (
          <ChatPanel
            messages={chatMessages}
            onSend={onSendChat}
            onClose={() => setShowGuestChat(false)}
            senderName={userName}
          />
        )}

        {/* Sidebar (right) - host/co-host only */}
        {isHostOrCoHost && showSidebar && (
          <Sidebar
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
            stageBackground={stageBackground}
            onStageBackgroundChange={setStageBackground}
            brandColor={brandColor}
            onBrandColorChange={setBrandColor}
            logoUrl={logoUrl}
            onLogoUrlChange={setLogoUrl}
            scenes={scenes}
            activeSceneId={activeSceneId}
            onSaveScene={onSaveScene}
            onApplyScene={onApplyScene}
            onDeleteScene={onDeleteScene}
            onRenameScene={onRenameScene}
            tickers={tickers}
            onAddTicker={onAddTicker}
            onToggleTicker={onToggleTicker}
            onRemoveTicker={onRemoveTicker}
            onUpdateTicker={onUpdateTicker}
            chatMessages={chatMessages}
            highlightedComment={highlightedComment}
            onHighlightComment={onHighlightComment}
            onDismissComment={onDismissComment}
            chatPanelMessages={chatMessages}
            onSendChat={onSendChat}
            chatSenderName={userName}
            allParticipants={allParticipantsMap}
            myParticipantId={myParticipant?.id || ''}
            myRole={myParticipant?.role || 'guest'}
            onStageAction={onStageAction}
            remoteStreams={remoteStreams}
            localStream={localStream}
          />
        )}

        {/* Webinar Q&A Panel (host) */}
        {isHostOrCoHost && showWebinarQA && (
          <WebinarQAPanel
            questions={qaQuestions}
            onApprove={onApproveQuestion}
            onDismiss={onDismissQuestion}
            onAnswer={onAnswerQuestion}
            onHighlight={onHighlightQuestion}
            onUnhighlight={onUnhighlightQuestion}
            onClose={() => setShowWebinarQA(false)}
          />
        )}

        {/* Webinar Q&A Audience (guest) */}
        {!isHostOrCoHost && showWebinarQA && (
          <WebinarQAAudience
            questions={qaQuestions.filter(q => q.status === 'approved' || q.status === 'answered')}
            onSubmitQuestion={onSubmitQuestion}
            onUpvote={onUpvoteQuestion}
            myUpvotes={myUpvotes}
          />
        )}

        {/* Recording Panel */}
        {showRecordingPanel && (
          <RecordingPanel
            isRecording={isLocalRecording}
            formattedTime={localRecFormattedTime}
            onStartRecording={onStartLocalRecording}
            onStopRecording={stopLocalRecording}
            roomName={room?.name || 'Studio'}
            onClose={() => setShowRecordingPanel(false)}
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
        onOpenChat={() => setShowGuestChat(!showGuestChat)}
        onOpenParticipants={() => setShowParticipants(!showParticipants)}
        onOpenStreamDestinations={() => setShowStreamDest(!showStreamDest)}
        onOpenSoundBoard={() => setShowSoundBoard(!showSoundBoard)}
        onOpenTeleprompter={() => setShowTeleprompter(!showTeleprompter)}
        onOpenMediaPanel={() => setShowMediaPanel(!showMediaPanel)}
        onOpenBackgroundMusic={() => setShowBackgroundMusic(!showBackgroundMusic)}
        onOpenRecordingPanel={() => setShowRecordingPanel(!showRecordingPanel)}
        onOpenProducerPanel={() => setShowProducerPanel(!showProducerPanel)}
        onOpenWebinarQA={() => setShowWebinarQA(!showWebinarQA)}
        participantCount={allParticipantsMap.size}
        isLive={isLive}
      />

      {/* Producer Panel (full-screen overlay) */}
      {showProducerPanel && (
        <ProducerPanel
          participants={allParticipantsMap}
          myParticipantId={myParticipant?.id || ''}
          remoteStreams={remoteStreams}
          localStream={localStream}
          onStageAction={onStageAction}
          isLive={isLive}
          isRecording={isRecording}
          formattedTime={formattedTime}
          currentLayout={layout}
          onLayoutChange={setLayout}
          onClose={() => setShowProducerPanel(false)}
        />
      )}

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

      {/* Room Ending Countdown Overlay */}
      {roomEnding && (
        <div style={styles.roomEndingOverlay}>
          <div style={styles.roomEndingCard}>
            <div style={styles.roomEndingIcon}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </div>
            <h2 style={styles.roomEndingTitle}>Room is ending...</h2>
            <div style={styles.roomEndingCountdown}>{endingCountdown}</div>
            <p style={styles.roomEndingSubtitle}>The host is ending this session</p>
            <div style={styles.roomEndingBar}>
              <div
                style={{
                  ...styles.roomEndingBarFill,
                  width: `${((10 - endingCountdown) / 10) * 100}%`,
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
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
    background: 'rgba(15, 23, 42, 0.8)',
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
    flexShrink: 0,
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
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
    padding: 12,
    gap: 8,
    overflow: 'hidden',
    position: 'relative',
    background: 'rgba(0, 0, 0, 0.15)',
  },
  canvasWrapper: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    minHeight: 0,
  },
  canvas: {
    position: 'relative',
    width: '100%',
    maxHeight: '100%',
    aspectRatio: '16 / 9',
    borderRadius: 14,
    overflow: 'hidden',
    border: '2px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 4px 24px rgba(0, 0, 0, 0.3)',
    background: '#0f172a',
  },
  grid: {
    display: 'grid',
    gap: 6,
    width: '100%',
    height: '100%',
    padding: 6,
    transition: 'all 0.3s ease',
  },
  layoutBar: {
    flexShrink: 0,
    zIndex: 10,
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
  // Single layout
  singleTile: {
    width: '100%',
    height: '100%',
    transition: 'all 0.3s ease',
  },
  // Featured layout
  featuredMain: {
    height: '100%',
    minHeight: 0,
    transition: 'all 0.3s ease',
  },
  featuredSide: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
    height: '100%',
    minHeight: 0,
    overflow: 'auto',
    transition: 'all 0.3s ease',
  },
  featuredSideTile: {
    flex: 1,
    minHeight: 80,
    transition: 'all 0.3s ease',
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
  // Room ending overlay
  roomEndingOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.75)',
    backdropFilter: 'blur(8px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  roomEndingCard: {
    background: 'rgba(15, 23, 42, 0.95)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 18,
    padding: '40px 48px',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 8,
    minWidth: 320,
    boxShadow: '0 24px 48px rgba(0, 0, 0, 0.4)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  },
  roomEndingIcon: {
    color: 'var(--text-muted)',
    marginBottom: 8,
  },
  roomEndingTitle: {
    fontSize: 20,
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: 0,
    letterSpacing: '-0.01em',
  },
  roomEndingCountdown: {
    fontSize: 64,
    fontWeight: 700,
    color: 'var(--accent)',
    fontFamily: 'monospace',
    lineHeight: 1,
    margin: '12px 0',
  },
  roomEndingSubtitle: {
    fontSize: 14,
    color: 'var(--text-secondary)',
    margin: 0,
  },
  roomEndingBar: {
    width: '100%',
    height: 4,
    borderRadius: 2,
    background: 'var(--bg-tertiary)',
    marginTop: 20,
    overflow: 'hidden',
  },
  roomEndingBarFill: {
    height: '100%',
    background: 'var(--accent)',
    borderRadius: 2,
    transition: 'width 1s linear',
  },
  // Logo watermark
  logoWatermark: {
    position: 'absolute',
    top: 12,
    right: 12,
    zIndex: 6,
    opacity: 0.85,
    pointerEvents: 'none',
  },
  logoWatermarkImg: {
    maxHeight: 32,
    maxWidth: 100,
    objectFit: 'contain',
  },
};
