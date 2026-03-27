import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { SignalMessage, Participant, Room, LayoutMode, ChatMessage, StreamDestination, StageActionPayload, StageBackground, Scene, CameraShape, NameTagStyle } from '@studio/shared';

function assertNever(value: never): never {
  throw new Error(`Unhandled discriminated union member: ${JSON.stringify(value)}`);
}

import { useSignaling } from '../hooks/useSignaling.ts';
import { useMediaDevices } from '../hooks/useMediaDevices.ts';
import { useWebRTC } from '../hooks/useWebRTC.ts';
import { useRecording } from '../hooks/useRecording.ts';
import { useScreenShare } from '../hooks/useScreenShare.ts';
import { useLocalRecording } from '../hooks/useLocalRecording.ts';
import { useCompositor } from '../hooks/useCompositor.ts';
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
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // UI panels
  const [showDeviceSettings, setShowDeviceSettings] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
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

  const [stageBackground, setStageBackground] = useState<StageBackground>({ type: 'none', value: '' });
  const [brandColor, setBrandColor] = useState('#a78bfa');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [cameraShape, setCameraShape] = useState<CameraShape>('rectangle');
  const [nameTagStyle, setNameTagStyle] = useState<NameTagStyle>('classic');
  const [pipCorner, setPipCorner] = useState<'TL' | 'TR' | 'BL' | 'BR'>('BR');

  // Cleanup blob URLs when logoUrl changes
  useEffect(() => {
    const url = logoUrl;
    return () => {
      if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
    };
  }, [logoUrl]);

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
    selectedAudioOutputDeviceId,
    onAudioOutputDeviceChange,
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

  const noopFn = useCallback(() => {}, []);
  const joinedRef = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const myParticipantRef = useRef<Participant | null>(null);
  const idCounters = useRef({ lt: 0, dest: 0, banner: 0, timer: 0, ticker: 0, qa: 0 });
  const audioEnabledRef = useRef(audioEnabled);
  const videoEnabledRef = useRef(videoEnabled);
  const isScreenSharingRef = useRef(isScreenSharing);
  const localStreamRef = useRef<MediaStream | null>(localStream);

  // Refs for signaling handler dependencies to reduce recreation frequency
  const connectToPeerRef = useRef(connectToPeer);
  const handleOfferRef = useRef(handleOffer);
  const handleAnswerRef = useRef(handleAnswer);
  const handleIceCandidateRef = useRef(handleIceCandidate);
  const removePeerRef = useRef(removePeer);
  const cleanupRef = useRef(cleanup);
  const stopMediaRef = useRef(stopMedia);
  const stopScreenShareRef = useRef(stopScreenShare);
  const navigateRef = useRef(navigate);

  // Refs for onToggleScreenShare dependencies
  const replaceTrackRef = useRef(replaceTrack);
  const startScreenShareRef = useRef(startScreenShare);
  const sendRef = useRef(send);

  // Initialize Canvas Compositor for RTMP
  const { compositeStreamRef, compositeCanvasRef } = useCompositor({
    containerRef: stageRef,
    isLive,
    banners,
    lowerThirds,
    tickers,
    brandColor,
    logoUrl,
  });

  // Keep refs in sync with state
  useEffect(() => {
    myParticipantRef.current = myParticipant;
  }, [myParticipant]);
  useEffect(() => { audioEnabledRef.current = audioEnabled; }, [audioEnabled]);
  useEffect(() => { videoEnabledRef.current = videoEnabled; }, [videoEnabled]);
  useEffect(() => { isScreenSharingRef.current = isScreenSharing; }, [isScreenSharing]);
  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);

  // Keep function refs in sync
  useEffect(() => { connectToPeerRef.current = connectToPeer; }, [connectToPeer]);
  useEffect(() => { handleOfferRef.current = handleOffer; }, [handleOffer]);
  useEffect(() => { handleAnswerRef.current = handleAnswer; }, [handleAnswer]);
  useEffect(() => { handleIceCandidateRef.current = handleIceCandidate; }, [handleIceCandidate]);
  useEffect(() => { removePeerRef.current = removePeer; }, [removePeer]);
  useEffect(() => { cleanupRef.current = cleanup; }, [cleanup]);
  useEffect(() => { stopMediaRef.current = stopMedia; }, [stopMedia]);
  useEffect(() => { stopScreenShareRef.current = stopScreenShare; }, [stopScreenShare]);
  useEffect(() => { navigateRef.current = navigate; }, [navigate]);
  useEffect(() => { replaceTrackRef.current = replaceTrack; }, [replaceTrack]);
  useEffect(() => { startScreenShareRef.current = startScreenShare; }, [startScreenShare]);
  useEffect(() => { sendRef.current = send; }, [send]);

  // Connect WebSocket and start media on mount
  useEffect(() => {
    connect();
    startMedia();
  }, [connect, startMedia]);

  // Fix 1: Reset joinedRef and clear room-ending state when disconnected so room-join is re-sent on reconnect
  useEffect(() => {
    if (!connected) {
      joinedRef.current = false;
      setRoomEnding(false);
      setEndingCountdown(10);
    }
  }, [connected]);

  // WebSocket connection timeout: show error if not connected within 10 seconds
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!connected) {
        setConnectionError('Unable to connect to server. Please check your connection and try again.');
      }
    }, 10000);
    return () => clearTimeout(timeout);
  }, [connected]);

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
            setTimeout(() => connectToPeerRef.current(p.id).catch(err => console.error('Failed to connect to peer:', err)), 100);
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
          removePeerRef.current(participantId);
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
          handleOfferRef.current(message.payload.from, message.payload.sdp).catch(err => console.error('Failed to handle offer:', err));
          break;
        case 'answer':
          handleAnswerRef.current(message.payload.from, message.payload.sdp).catch(err => console.error('Failed to handle answer:', err));
          break;
        case 'ice-candidate':
          handleIceCandidateRef.current(message.payload.from, message.payload.candidate).catch(err => console.error('Failed to handle ICE candidate:', err));
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
            const next = [...prev, message.payload];
            return next.length > 500 ? next.slice(-500) : next;
          });
          break;
        case 'room-ending':
          setRoomEnding(true);
          setEndingCountdown(message.payload.countdown);
          break;
        case 'room-ending-cancelled':
          setRoomEnding(false);
          setEndingCountdown(10);
          break;
        case 'host-changed':
          setRoom((prev) => prev ? { ...prev, hostId: message.payload.newHostId } : prev);
          break;
        case 'room-ended':
          setRoomEnding(false);
          cleanupRef.current();
          stopMediaRef.current();
          stopScreenShareRef.current();
          navigateRef.current('/');
          break;
        case 'error':
          console.error('Server error:', message.payload.message);
          if (message.payload.code === 'ROOM_NOT_FOUND') {
            setConnectionError('This room does not exist or has ended.');
          }
          break;
        // Client-to-server messages: not expected here but listed for exhaustive check
        case 'join-room':
        case 'stage-action':
        case 'end-room':
          break;
        default:
          assertNever(message);
      }
    },
    [] // No external dependencies — all mutable values accessed via refs
  );

  useEffect(() => {
    const rm = addHandler(handleSignalingMessage);
    return rm;
  }, [addHandler, handleSignalingMessage]);

  // Sync local tracks when remotely muted/unmuted
  useEffect(() => {
    if (!myParticipant || !localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack && audioTrack.enabled !== myParticipant.audioEnabled) {
      audioTrack.enabled = myParticipant.audioEnabled;
    }
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack && videoTrack.enabled !== myParticipant.videoEnabled) {
      videoTrack.enabled = myParticipant.videoEnabled;
    }
  }, [myParticipant?.audioEnabled, myParticipant?.videoEnabled, localStream]);

  // ====== Actions ======

  const onToggleAudio = useCallback(() => {
    const s = toggleAudio();
    if (myParticipantRef.current) send({ type: 'media-state-changed', payload: { participantId: myParticipantRef.current.id, audioEnabled: s, videoEnabled: videoEnabledRef.current, screenSharing: isScreenSharingRef.current } });
  }, [toggleAudio, send]);
  const onToggleVideo = useCallback(() => {
    const s = toggleVideo();
    if (myParticipantRef.current) send({ type: 'media-state-changed', payload: { participantId: myParticipantRef.current.id, audioEnabled: audioEnabledRef.current, videoEnabled: s, screenSharing: isScreenSharingRef.current } });
  }, [toggleVideo, send]);
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
  // Screen sharing — replace the camera video track on all peer connections
  // so remote participants actually receive the screen feed.
  const onToggleScreenShare = useCallback(async () => {
    if (isScreenSharingRef.current) {
      stopScreenShareRef.current();
      // Restore the camera video track on all peer connections
      const cameraTrack = localStreamRef.current?.getVideoTracks()[0];
      if (cameraTrack) await replaceTrackRef.current(cameraTrack);
      if (myParticipantRef.current) sendRef.current({ type: 'media-state-changed', payload: { participantId: myParticipantRef.current.id, audioEnabled: audioEnabledRef.current, videoEnabled: videoEnabledRef.current, screenSharing: false } });
    } else {
      try {
        const stream = await startScreenShareRef.current();
        if (stream && myParticipantRef.current) {
          // Replace the camera video track with the screen video track on all peers
          const screenTrack = stream.getVideoTracks()[0];
          if (screenTrack) {
            await replaceTrackRef.current(screenTrack);
            // When the user stops sharing via the browser's native button,
            // restore the camera track automatically
            screenTrack.addEventListener('ended', async () => {
              stopScreenShareRef.current();
              const camTrack = localStreamRef.current?.getVideoTracks()[0];
              if (camTrack) await replaceTrackRef.current(camTrack);
              if (myParticipantRef.current) {
                sendRef.current({ type: 'media-state-changed', payload: { participantId: myParticipantRef.current.id, audioEnabled: audioEnabledRef.current, videoEnabled: videoEnabledRef.current, screenSharing: false } });
              }
            });
          }
          sendRef.current({ type: 'media-state-changed', payload: { participantId: myParticipantRef.current.id, audioEnabled: audioEnabledRef.current, videoEnabled: videoEnabledRef.current, screenSharing: true } });
        }
      } catch (err) {
        // User cancelled screen share dialog or permission denied
        console.warn('Screen share cancelled or failed:', err);
      }
    }
  }, []); // All mutable values accessed via refs

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
    setChatMessages((prev) => {
      const next = [...prev, msg];
      return next.length > 500 ? next.slice(-500) : next;
    });
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
  const onUpdateTimer = useCallback((id: string, updates: Partial<TimerData>) => {
    setTimers((prev) => prev.map((t) => t.id === id ? { ...t, ...updates } : t));
  }, []);

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

  // Helper to convert blob URL to data URL
  const blobToDataUrl = async (blobUrl: string): Promise<string> => {
    const response = await fetch(blobUrl);
    const blob = await response.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
  };

  // Scenes
  const onSaveScene = async (name: string) => {
    // Convert blob URL to data URL so the scene survives blob revocation
    let persistedLogoUrl = logoUrl;
    if (logoUrl && logoUrl.startsWith('blob:')) {
      try {
        persistedLogoUrl = await blobToDataUrl(logoUrl);
      } catch {
        // Keep original URL if conversion fails
      }
    }

    const newScene: Scene = {
      id: `scene-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      layout,
      background: stageBackground,
      brandColor,
      logoUrl: persistedLogoUrl,
      cameraShape,
      nameTagStyle,
      visibleOverlayIds: [
        ...lowerThirds.filter(o => o.visible).map(o => o.id),
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
    if (sceneId === activeSceneId) return;
    setLayout(scene.layout);
    setStageBackground(scene.background);
    setBrandColor(scene.brandColor || '#a78bfa');
    setLogoUrl(scene.logoUrl || null);
    setCameraShape(scene.cameraShape || 'rectangle');
    setNameTagStyle(scene.nameTagStyle || 'classic');
    // Restore overlay visibility from saved scene
    const visibleIds = new Set(scene.visibleOverlayIds);
    setLowerThirds(prev => prev.map(o => ({ ...o, visible: scene.visibleOverlayIds.includes(o.id) })));
    setBanners(prev => prev.map(b => ({ ...b, visible: visibleIds.has(b.id) })));
    setTimers(prev => prev.map(t => ({ ...t, visible: visibleIds.has(t.id) })));
    setTickers(prev => prev.map(t => ({ ...t, visible: visibleIds.has(t.id) })));
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
        items.push({ id, name: p.screenSharing ? `${p.name}'s screen` : p.name, stream: remoteStreams.get(id) || null, isLocal: false, audioEnabled: p.screenSharing ? false : p.audioEnabled, videoEnabled: p.screenSharing ? true : p.videoEnabled, isScreenShare: p.screenSharing || false });
      }
    }
    return items;
  }, [myParticipant, participants, localStream, audioEnabled, videoEnabled, remoteStreams, isScreenSharing, screenStream]);

  // Auto-switch layout when participant count changes
  useEffect(() => {
    const count = videoItems.length;
    // Layouts requiring >= 2 participants
    if (count < 2 && (layout === 'spotlight' || layout === 'featured' || layout === 'side-by-side' || layout === 'pip')) {
      setLayout(count === 1 ? 'single' : 'grid');
    }
    // Single layout with multiple participants should switch to grid
    if (count > 1 && layout === 'single') {
      setLayout('grid');
    }
  }, [videoItems.length, layout]);

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

  // ====== Layout Engine ======
  // Each layout helper returns { containerStyle, tileStyles[], mode }.
  // The rendering section uses containerStyle on the wrapper and applies
  // tileStyles[i] to each tile so that centering and sizing are precise.

  type LayoutResult = {
    containerStyle: React.CSSProperties;
    tileStyles: React.CSSProperties[];
    mode: 'flex' | 'grid' | 'custom';
  };

  const GAP = 8;

  // Shared base — border-box prevents padding overflow beyond the 16:9 canvas
  const containerBase: React.CSSProperties = {
    width: '100%',
    height: '100%',
    padding: 8,
    boxSizing: 'border-box' as const,
  };

  // Optimal auto-grid for 1-12 participants.
  // Uses flexbox + percentage widths; justify-content:center handles
  // centering the last row when it has fewer tiles than the row above.
  const getAutoGridLayout = useCallback((count: number): LayoutResult => {
    if (count <= 0) return { containerStyle: { ...containerBase, display: 'flex' }, tileStyles: [], mode: 'flex' };

    let maxCols = 1;
    if (count >= 2 && count <= 4) maxCols = 2;
    else if (count >= 5 && count <= 9) maxCols = 3;
    else if (count >= 10 && count <= 16) maxCols = 4;
    else maxCols = Math.ceil(Math.sqrt(count * 16 / 9));

    const tileW = `calc(${100 / maxCols}% - ${GAP * (maxCols - 1) / maxCols}px)`;

    const tiles: React.CSSProperties[] = Array.from({ length: count }, () => ({
      width: tileW,
      aspectRatio: '16 / 9',
      flexShrink: 0,
      flexGrow: 0,
    }));

    return {
      containerStyle: {
        ...containerBase,
        display: 'flex',
        flexWrap: 'wrap' as const,
        justifyContent: 'center',
        alignContent: 'center',
        gap: GAP,
      },
      tileStyles: tiles,
      mode: 'flex',
    };
  }, []);

  // Screen share layout: screen tile gets prominent placement.
  const getScreenShareLayout = useCallback((items: typeof videoItems): LayoutResult => {
    const screenIdx = items.findIndex(v => v.isScreenShare);
    const speakerCount = items.length - 1;

    if (speakerCount <= 4) {
      // CSS Grid: screen takes left column, speakers stack in right column
      const speakerRows = Math.max(speakerCount, 1);
      const tiles: React.CSSProperties[] = items.map((_, i) => {
        if (i === screenIdx) {
          return { gridColumn: '1', gridRow: `1 / ${speakerRows + 1}`, width: '100%', aspectRatio: '16 / 9', alignSelf: 'center' };
        }
        const si = i < screenIdx ? i : i - 1;
        return { gridColumn: '2', gridRow: `${si + 1}`, width: '100%', aspectRatio: '16 / 9', alignSelf: 'center' };
      });
      return {
        containerStyle: {
          ...containerBase,
          display: 'grid',
          gridTemplateColumns: speakerCount > 0 ? '1fr 0.32fr' : '1fr',
          gridTemplateRows: `repeat(${speakerRows}, 1fr)`,
          gap: GAP,
          alignItems: 'center',
          justifyItems: 'center',
        },
        tileStyles: tiles,
        mode: 'grid',
      };
    }
    // 5+ speakers: screen on top 80%, speaker strip at bottom 20%
    const tiles: React.CSSProperties[] = items.map((_, i) => {
      if (i === screenIdx) {
        return { width: `calc(80% - ${GAP}px)`, aspectRatio: '16 / 9', flexShrink: 0, flexGrow: 0, order: 0 };
      }
      return {
        width: `calc(20% - ${GAP}px)`,
        aspectRatio: '16 / 9',
        flexShrink: 0, flexGrow: 0, order: 1,
      };
    });
    return {
      containerStyle: { ...containerBase, display: 'flex', flexWrap: 'wrap' as const, justifyContent: 'center', alignContent: 'center', gap: GAP },
      tileStyles: tiles,
      mode: 'custom',
    };
  }, []);

  // Spotlight: 1 large tile top ~74%, thumbnail strip bottom ~26%
  const getSpotlightLayout = useCallback((count: number): LayoutResult => {
    if (count <= 1) return getAutoGridLayout(count);
    const thumbCount = count - 1;
    const maxThumbsPerRow = Math.max(3, Math.min(thumbCount, 6)); 
    const thumbW = 100 / maxThumbsPerRow;
    const mainW = 100 - thumbW; 

    const tiles: React.CSSProperties[] = [
      { width: `calc(${mainW}% - ${GAP}px)`, aspectRatio: '16 / 9', flexShrink: 0, flexGrow: 0 },
    ];
    for (let i = 0; i < thumbCount; i++) {
      tiles.push({
        width: `calc(${thumbW}% - ${GAP}px)`,
        aspectRatio: '16 / 9',
        flexShrink: 0, flexGrow: 0,
      });
    }
    return {
      containerStyle: { ...containerBase, display: 'flex', flexWrap: 'wrap' as const, justifyContent: 'center', alignContent: 'center', gap: GAP },
      tileStyles: tiles,
      mode: 'flex',
    };
  }, [getAutoGridLayout]);

  // Featured: 1 large tile ~72% left + side tiles ~28% right (CSS Grid for clean stacking)
  const getFeaturedLayout = useCallback((count: number): LayoutResult => {
    if (count <= 1) return getAutoGridLayout(count);
    const sideCount = count - 1;
    const tiles: React.CSSProperties[] = [
      { gridColumn: '1', gridRow: `1 / ${sideCount + 1}`, width: '100%', aspectRatio: '16 / 9', alignSelf: 'center' },
    ];
    for (let i = 0; i < sideCount; i++) {
      tiles.push({
        gridColumn: '2', gridRow: `${i + 1}`, width: '100%', aspectRatio: '16 / 9', alignSelf: 'center',
      });
    }
    return {
      containerStyle: {
        ...containerBase,
        display: 'grid',
        gridTemplateColumns: '1fr 0.38fr',
        gridTemplateRows: `repeat(${sideCount}, 1fr)`,
        gap: GAP,
        alignItems: 'center',
        justifyItems: 'center',
      },
      tileStyles: tiles,
      mode: 'grid',
    };
  }, [getAutoGridLayout]);

  // Final computed layout
  const layoutResult = useMemo((): LayoutResult => {
    const count = videoItems.length;
    const hasScreenShare = videoItems.some(v => v.isScreenShare);

    // Screen share layout takes priority across all layout modes
    if (hasScreenShare) {
      return getScreenShareLayout(videoItems);
    }

    switch (layout) {
      case 'grid':
        return getAutoGridLayout(count);
      case 'spotlight':
        return getSpotlightLayout(count);
      case 'featured':
        return getFeaturedLayout(count);
      case 'side-by-side': {
        const showCount = Math.min(count, 2);
        const tiles: React.CSSProperties[] = Array.from({ length: showCount }, () => ({
          width: showCount === 2 ? `calc(50% - ${GAP / 2}px)` : '100%',
          aspectRatio: '16 / 9',
          flexShrink: 0, flexGrow: 0,
        }));
        return {
          containerStyle: { ...containerBase, display: 'flex', justifyContent: 'center', alignItems: 'center', alignContent: 'center', gap: GAP },
          tileStyles: tiles,
          mode: 'flex',
        };
      }
      case 'pip': {
        const pipPos = {
          TL: { top: 20, left: 20 },
          TR: { top: 20, right: 20 },
          BL: { bottom: 20, left: 20 },
          BR: { bottom: 20, right: 20 },
        }[pipCorner];
        const tiles: React.CSSProperties[] = [
          { width: '100%', aspectRatio: '16 / 9', flexShrink: 0, flexGrow: 0 },
        ];
        if (count >= 2) {
          tiles.push({
            position: 'absolute' as const,
            ...pipPos,
            width: '24%',
            aspectRatio: '16 / 9',
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: '0 4px 24px rgba(0, 0, 0, 0.5)',
            border: '2px solid rgba(255, 255, 255, 0.15)',
            zIndex: 5,
            flexShrink: 0, flexGrow: 0,
            cursor: 'pointer',
            transition: 'top 0.3s ease, bottom 0.3s ease, left 0.3s ease, right 0.3s ease',
          });
        }
        return {
          containerStyle: { ...containerBase, display: 'flex', justifyContent: 'center', alignItems: 'center', position: 'relative' as const },
          tileStyles: tiles,
          mode: 'custom',
        };
      }
      case 'single': {
        return {
          containerStyle: { ...containerBase, display: 'flex', justifyContent: 'center', alignItems: 'center' },
          tileStyles: count > 0 ? [{ width: '100%', aspectRatio: '16 / 9', flexShrink: 0, flexGrow: 0 }] : [],
          mode: 'flex',
        };
      }
      default:
        return assertNever(layout);
    }
  }, [layout, videoItems, getAutoGridLayout, getScreenShareLayout, getSpotlightLayout, getFeaturedLayout]);

  // These must be called before any conditional returns to satisfy Rules of Hooks
  const visibleBanners = useMemo(() => banners.filter(b => b.visible), [banners]);
  const visibleTimers = useMemo(() => timers.filter(t => t.visible), [timers]);
  const visibleTickers = useMemo(() => tickers.filter(t => t.visible), [tickers]);
  const highlightedQA = useMemo(() => qaQuestions.find(q => q.highlighted) || null, [qaQuestions]);

  // Connection error
  if (connectionError) {
    return (
      <div style={styles.loading}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M15 9l-6 6M9 9l6 6" />
        </svg>
        <p style={{ ...styles.loadingText, color: '#ef4444', marginTop: 16 }}>{connectionError}</p>
        <button
          className="btn-primary"
          style={{ marginTop: 16, padding: '10px 24px', borderRadius: 10, fontSize: 14, fontWeight: 600 }}
          onClick={() => navigate('/')}
        >
          Go to homepage
        </button>
      </div>
    );
  }

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
              title="Toggle sidebar"
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
              <button className="hover-scale" style={styles.screenShareStopBtn} onClick={onToggleScreenShare} aria-label="Stop screen sharing">Stop Sharing</button>
            </div>
          )}

          {/* Fixed 16:9 Canvas */}
          <div style={styles.canvasWrapper}>
            <div ref={stageRef} style={{ ...styles.canvas, ...stageBackgroundStyle }}>
              <div style={{ ...styles.gridBase, ...layoutResult.containerStyle, position: 'relative' }}>
                {/* Render tiles based on layout engine */}
                {(() => {
                  // Determine which items to render based on layout
                  const itemsToRender = layout === 'side-by-side'
                    ? videoItems.slice(0, 2)
                    : layout === 'single'
                      ? videoItems.slice(0, 1)
                      : layout === 'pip'
                        ? videoItems.slice(0, 2)
                        : videoItems;

                  return itemsToRender.map((item, i) => {
                    const isPipSmallTile = layout === 'pip' && i === 1;
                    return (
                      <div
                        key={item.id}
                        style={{ ...styles.tileWrapper, ...(layoutResult.tileStyles[i] || {}) }}
                        onClick={isPipSmallTile ? () => {
                          setPipCorner((prev) => {
                            const order: Array<'TL' | 'TR' | 'BR' | 'BL'> = ['TL', 'TR', 'BR', 'BL'];
                            return order[(order.indexOf(prev) + 1) % 4];
                          });
                        } : undefined}
                        title={isPipSmallTile ? 'Click to move PiP position' : undefined}
                      >
                        <VideoTile
                          stream={item.stream}
                          name={item.name}
                          isLocal={item.isLocal}
                          isScreenShare={item.isScreenShare}
                          audioEnabled={item.audioEnabled}
                          videoEnabled={item.videoEnabled}
                          brandColor={brandColor}
                          cameraShape={cameraShape}
                          nameTagStyle={nameTagStyle}
                        />
                      </div>
                    );
                  });
                })()}

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
                    <button className="panel-close-btn" style={styles.mediaCloseBtn} onClick={onStopMedia} aria-label="Close media overlay">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                )}

                {/* Lower Third Overlay */}
                {visibleLowerThird && <LowerThirdOverlay data={visibleLowerThird} />}

                {/* Banner Overlays */}
                {visibleBanners.map((b) => (
                  <BannerOverlayDisplay key={b.id} data={b} />
                ))}

                {/* Timer Overlays */}
                {visibleTimers.map((t) => (
                  <TimerOverlayDisplay key={t.id} data={t} />
                ))}

                {/* Ticker Overlays */}
                {visibleTickers.map((t) => (
                  <TickerOverlayDisplay key={t.id} data={t} />
                ))}

                {/* Comment Highlight Overlay */}
                <CommentHighlightOverlay comment={highlightedComment} />

                {/* Webinar Q&A Overlay */}
                <WebinarQAOverlay question={highlightedQA} />
              </div>

              {/* Logo watermark */}
              {logoUrl && (
                <div style={styles.logoWatermark}>
                  <img src={logoUrl} alt="Logo" style={styles.logoWatermarkImg} />
                </div>
              )}

              {/* Debug Compositor Preview (Only visible when LIVE) */}
              {isLive && (
                <div style={{ position: 'absolute', top: 16, right: 16, width: 240, aspectRatio: '16/9', border: '2px solid red', borderRadius: 8, overflow: 'hidden', zIndex: 1000, background: '#000', boxShadow: '0 4px 12px rgba(0,0,0,0.5)' }}>
                  <span style={{ position: 'absolute', top: 4, left: 4, background: 'red', color: 'white', fontSize: 10, padding: '2px 4px', borderRadius: 4, fontWeight: 'bold', zIndex: 10 }}>COMPOSITOR OUTPUT</span>
                  <video
                    autoPlay
                    muted
                    playsInline
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                    ref={(el) => {
                      if (el && compositeStreamRef.current && el.srcObject !== compositeStreamRef.current) {
                        el.srcObject = compositeStreamRef.current;
                      }
                    }}
                  />
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
            cameraShape={cameraShape}
            onCameraShapeChange={setCameraShape}
            nameTagStyle={nameTagStyle}
            onNameTagStyleChange={setNameTagStyle}
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
        onOpenParticipants={noopFn}
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
      {isHostOrCoHost && showProducerPanel && (
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
  roomTitle: { fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
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
  // Base grid container — actual layout props are merged from layoutResult.containerStyle
  gridBase: {
    width: '100%',
    height: '100%',
    boxSizing: 'border-box' as const,
    transition: 'opacity 0.3s ease, gap 0.3s ease',
  },
  // Generic tile wrapper — per-tile sizing is merged from layoutResult.tileStyles[i]
  tileWrapper: {
    boxSizing: 'border-box' as const,
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    borderRadius: 16,
    transition: 'width 0.3s ease, height 0.3s ease, flex-basis 0.3s ease, opacity 0.3s ease, border-radius 0.3s ease, transform 0.3s ease',
  },
  layoutBar: {
    flexShrink: 0,
    zIndex: 10,
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
