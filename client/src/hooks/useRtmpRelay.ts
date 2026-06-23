import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BroadcastOrientation,
  RtmpRelayDestination,
  RtmpRelayDestinationStatus,
  RtmpRelayServerMessage,
  RtmpRelayVideoConfig,
} from '@studio/shared';
import { resolveMediaWsUrl } from '../utils/apiClient.ts';
import {
  getRelayReconnectPlan,
  MAX_RELAY_RECONNECT_ATTEMPTS,
  RELAY_RECONNECT_DELAY_MS,
} from '../utils/rtmpRelayReconnect.ts';
import { estimateDroppedFrames } from '../utils/rtmpRelayDrops.ts';
import { getRelayLatencyMs } from '../utils/rtmpRelayLatency.ts';
import {
  getRtmpRelayVideoConfig,
  RTMP_RELAY_AUDIO_BITS_PER_SECOND,
  type RtmpRelayOutputPresetId,
} from '../utils/rtmpRelayOutput.ts';
import { getDuckedParticipantVolumes } from '../utils/audioDucking.ts';
import { getLiveAudioTracks } from '../utils/audioStreamTracks.ts';

interface UseRtmpRelayOptions {
  compositeStreamRef: React.MutableRefObject<MediaStream | null>;
  localStream: MediaStream | null;
  localParticipantId?: string | null;
  remoteStreams: Map<string, MediaStream>;
  screenStream: MediaStream | null;
  auxiliaryAudioStream?: MediaStream | null;
  ensureAuxiliaryAudioStream?: () => MediaStream | null;
  participantVolumes?: Record<string, number>;
  participantAudioLevels?: Record<string, number>;
  audioDuckingEnabled?: boolean;
  readinessEnabled?: boolean;
  onDestinationStatus: (destinationId: string, status: RtmpRelayDestinationStatus, message?: string) => void;
  onRelayStopped?: (message: string) => void;
}

interface StartRelayOptions {
  token: string;
  refreshToken?: () => Promise<string>;
  destinations: RtmpRelayDestination[];
  orientation: BroadcastOrientation;
  outputPreset: RtmpRelayOutputPresetId;
}

interface MixerResources {
  audioContext: AudioContext;
  stream: MediaStream;
  videoResources: RelayVideoResources;
  sources: MediaStreamAudioSourceNode[];
  gains: GainNode[];
  participantGains: Map<string, GainNode>;
  silentOscillator?: OscillatorNode;
}

interface RelayVideoResources {
  stream: MediaStream;
  cleanup: () => void;
}

export interface RtmpRelayStats {
  status: 'idle' | 'connecting' | 'live' | 'error';
  startedAt: number | null;
  lastChunkAt: number | null;
  updatedAt: number;
  sentBytes: number;
  chunksSent: number;
  bitrateKbps: number;
  bitrateHistory: Array<{ at: number; kbps: number }>;
  droppedChunks: number;
  droppedFrames: number;
  reconnectAttempts: number;
  relayLatencyMs: number | null;
}

export interface RtmpRelayReadiness {
  status: 'checking' | 'ready' | 'unavailable';
  message: string;
  mediaWsUrl: string;
  checkedAt: number | null;
}

interface BitrateSample {
  at: number;
  bytes: number;
}

const RELAY_AUDIO = {
  sampleRate: 48_000,
  channelCount: 2,
  audioBitsPerSecond: RTMP_RELAY_AUDIO_BITS_PER_SECOND,
};

const INITIAL_RELAY_STATS: RtmpRelayStats = {
  status: 'idle',
  startedAt: null,
  lastChunkAt: null,
  updatedAt: 0,
  sentBytes: 0,
  chunksSent: 0,
  bitrateKbps: 0,
  bitrateHistory: [],
  droppedChunks: 0,
  droppedFrames: 0,
  reconnectAttempts: 0,
  relayLatencyMs: null,
};

const BITRATE_WINDOW_MS = 5_000;
const BITRATE_HISTORY_WINDOW_MS = 60_000;
const RELAY_PREFLIGHT_TIMEOUT_MS = 4_000;
const RELAY_HEARTBEAT_INTERVAL_MS = 5_000;
const MAX_PENDING_RELAY_PINGS = 8;
const RELAY_RECORDER_TIMESLICE_MS = 1_000;

const INITIAL_RELAY_READINESS: RtmpRelayReadiness = {
  status: 'checking',
  message: 'Checking media relay...',
  mediaWsUrl: '',
  checkedAt: null,
};

function clampVolume(volume: number | undefined): number {
  if (!Number.isFinite(volume)) return 1;
  return Math.min(1, Math.max(0, volume ?? 1));
}

function getMediaWsUrl(): string {
  return resolveMediaWsUrl();
}

function getRelayMimeType(): string {
  if (!('MediaRecorder' in window) || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  const candidates = [
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
}

function getBrowserRelayIssue(): string | null {
  if (!('WebSocket' in window)) return 'This browser does not support WebSocket streaming.';
  if (!('MediaRecorder' in window)) return 'This browser does not support MediaRecorder streaming.';
  if (!getRelayMimeType()) return 'This browser does not support WebM recording for RTMP relay.';
  return null;
}

function probeRelayWebSocket(mediaWsUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'Relay preflight complete');
      }
      if (error) reject(error);
      else resolve();
    };

    const timeout = window.setTimeout(() => {
      finish(new Error('Media relay did not respond in time.'));
    }, RELAY_PREFLIGHT_TIMEOUT_MS);

    try {
      ws = new WebSocket(mediaWsUrl);
    } catch (err) {
      window.clearTimeout(timeout);
      const message = err instanceof Error ? err.message : 'Invalid media relay URL.';
      reject(new Error(message));
      return;
    }

    ws.onopen = () => finish();
    ws.onerror = () => finish(new Error('Unable to reach the media relay server.'));
    ws.onclose = () => finish(new Error('Media relay connection closed before it was ready.'));
  });
}

function collectAudioSources(
  localStream: MediaStream | null,
  localParticipantId: string | null | undefined,
  remoteStreams: Map<string, MediaStream>,
  screenStream: MediaStream | null,
  auxiliaryAudioStream: MediaStream | null | undefined,
  participantVolumes: Record<string, number>
): Array<{ stream: MediaStream; volume: number; participantId?: string }> {
  const sources: Array<{ stream: MediaStream; volume: number; participantId?: string }> = [];
  const localAudioTracks = getLiveAudioTracks(localStream);
  if (localAudioTracks.length > 0) {
    sources.push({
      stream: new MediaStream(localAudioTracks),
      volume: localParticipantId ? clampVolume(participantVolumes[localParticipantId]) : 1,
      participantId: localParticipantId || undefined,
    });
  }
  for (const [participantId, stream] of remoteStreams) {
    const audioTracks = getLiveAudioTracks(stream);
    if (audioTracks.length > 0) {
      sources.push({
        stream: new MediaStream(audioTracks),
        volume: clampVolume(participantVolumes[participantId]),
        participantId,
      });
    }
  }
  const screenAudioTracks = getLiveAudioTracks(screenStream);
  if (screenAudioTracks.length > 0) sources.push({ stream: new MediaStream(screenAudioTracks), volume: 1 });
  const auxiliaryAudioTracks = getLiveAudioTracks(auxiliaryAudioStream);
  if (auxiliaryAudioTracks.length > 0) {
    sources.push({ stream: new MediaStream(auxiliaryAudioTracks), volume: 1 });
  }
  return sources;
}

function drawVideoCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number
) {
  if (video.videoWidth <= 0 || video.videoHeight <= 0) return;

  const sourceRatio = video.videoWidth / video.videoHeight;
  const targetRatio = width / height;
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = video.videoWidth;
  let sourceHeight = video.videoHeight;

  if (sourceRatio > targetRatio) {
    sourceWidth = video.videoHeight * targetRatio;
    sourceX = (video.videoWidth - sourceWidth) / 2;
  } else {
    sourceHeight = video.videoWidth / targetRatio;
    sourceY = (video.videoHeight - sourceHeight) / 2;
  }

  ctx.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
}

async function createRelayVideoStream(
  compositeStream: MediaStream,
  videoConfig: RtmpRelayVideoConfig
): Promise<RelayVideoResources> {
  const videoTrack = compositeStream.getVideoTracks()[0];
  if (!videoTrack || videoTrack.readyState !== 'live') {
    throw new Error('The composited studio video stream is not ready.');
  }

  if (videoConfig.width === 1920 && videoConfig.height === 1080) {
    return {
      stream: new MediaStream([videoTrack]),
      cleanup: () => undefined,
    };
  }

  const sourceStream = new MediaStream([videoTrack]);
  const sourceVideo = document.createElement('video');
  sourceVideo.muted = true;
  sourceVideo.playsInline = true;
  sourceVideo.srcObject = sourceStream;

  await new Promise<void>((resolve) => {
    if (sourceVideo.readyState >= 1) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(resolve, 1_000);
    sourceVideo.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      resolve();
    };
  });
  await sourceVideo.play().catch(() => undefined);

  const canvas = document.createElement('canvas');
  canvas.width = videoConfig.width;
  canvas.height = videoConfig.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas output is unavailable for portrait streaming.');

  let frame = 0;
  const draw = () => {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (sourceVideo.readyState >= 2) {
      drawVideoCover(ctx, sourceVideo, canvas.width, canvas.height);
    }
    frame = window.requestAnimationFrame(draw);
  };
  draw();

  const stream = canvas.captureStream(videoConfig.frameRate);
  return {
    stream,
    cleanup: () => {
      window.cancelAnimationFrame(frame);
      stream.getTracks().forEach((track) => track.stop());
      sourceVideo.pause();
      sourceVideo.srcObject = null;
    },
  };
}

async function createMixedBroadcastStream(
  compositeStream: MediaStream,
  videoConfig: RtmpRelayVideoConfig,
  localStream: MediaStream | null,
  localParticipantId: string | null | undefined,
  remoteStreams: Map<string, MediaStream>,
  screenStream: MediaStream | null,
  auxiliaryAudioStream: MediaStream | null | undefined,
  participantVolumes: Record<string, number>
): Promise<MixerResources> {
  const videoResources = await createRelayVideoStream(compositeStream, videoConfig);
  const videoTrack = videoResources.stream.getVideoTracks()[0];
  if (!videoTrack || videoTrack.readyState !== 'live') {
    throw new Error('The composited studio video stream is not ready.');
  }

  const AudioContextConstructor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error('Web Audio is not available in this browser.');
  }

  const audioContext = new AudioContextConstructor({ sampleRate: RELAY_AUDIO.sampleRate });
  const destination = audioContext.createMediaStreamDestination();
  const sources: MediaStreamAudioSourceNode[] = [];
  const gains: GainNode[] = [];
  const participantGains = new Map<string, GainNode>();
  const audioSources = collectAudioSources(
    localStream,
    localParticipantId,
    remoteStreams,
    screenStream,
    auxiliaryAudioStream,
    participantVolumes
  );

  for (const audioSource of audioSources) {
    const source = audioContext.createMediaStreamSource(audioSource.stream);
    const gain = audioContext.createGain();
    gain.gain.value = audioSource.volume;
    source.connect(gain);
    gain.connect(destination);
    sources.push(source);
    gains.push(gain);
    if (audioSource.participantId) participantGains.set(audioSource.participantId, gain);
  }

  let silentOscillator: OscillatorNode | undefined;
  if (sources.length === 0) {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    gain.gain.value = 0;
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();
    silentOscillator = oscillator;
  }

  const mixedStream = new MediaStream([
    videoTrack,
    ...destination.stream.getAudioTracks(),
  ]);

  return { audioContext, stream: mixedStream, videoResources, sources, gains, participantGains, silentOscillator };
}

function cleanupMixer(mixer: MixerResources | null) {
  if (!mixer) return;
  try {
    mixer.silentOscillator?.stop();
  } catch {
    // Already stopped.
  }
  mixer.stream.getAudioTracks().forEach((track) => track.stop());
  mixer.videoResources.cleanup();
  mixer.sources.forEach((source) => source.disconnect());
  mixer.gains.forEach((gain) => gain.disconnect());
  void mixer.audioContext.close();
}

export function useRtmpRelay({
  compositeStreamRef,
  localStream,
  localParticipantId,
  remoteStreams,
  screenStream,
  auxiliaryAudioStream,
  ensureAuxiliaryAudioStream,
  participantVolumes = {},
  participantAudioLevels = {},
  audioDuckingEnabled = false,
  readinessEnabled = true,
  onDestinationStatus,
  onRelayStopped,
}: UseRtmpRelayOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const mixerRef = useRef<MixerResources | null>(null);
  const activeDestinationIdsRef = useRef<string[]>([]);
  const intentionalStopRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const heartbeatTimerRef = useRef<number | null>(null);
  const heartbeatSequenceRef = useRef(0);
  const pendingHeartbeatsRef = useRef<Map<number, number>>(new Map());
  const bitrateSamplesRef = useRef<BitrateSample[]>([]);
  const sentBytesRef = useRef(0);
  const readinessCheckIdRef = useRef(0);
  const [stats, setStats] = useState<RtmpRelayStats>(INITIAL_RELAY_STATS);
  const [readiness, setReadiness] = useState<RtmpRelayReadiness>(INITIAL_RELAY_READINESS);

  const setRelayStatus = useCallback((status: RtmpRelayStats['status']) => {
    setStats((current) => ({ ...current, status, updatedAt: Date.now() }));
  }, []);

  const resetStats = useCallback((status: RtmpRelayStats['status'] = 'idle') => {
    bitrateSamplesRef.current = [];
    sentBytesRef.current = 0;
    setStats({
      ...INITIAL_RELAY_STATS,
      status,
      startedAt: status === 'idle' ? null : Date.now(),
      updatedAt: Date.now(),
    });
  }, []);

  const markDroppedChunk = useCallback((estimatedFrames = 0) => {
    setStats((current) => ({
      ...current,
      droppedChunks: current.droppedChunks + 1,
      droppedFrames: current.droppedFrames + Math.max(0, Math.round(estimatedFrames)),
      status: current.status === 'idle' ? 'error' : current.status,
      updatedAt: Date.now(),
    }));
  }, []);

  const markChunkSent = useCallback((bytes: number) => {
    const now = Date.now();
    sentBytesRef.current += bytes;
    bitrateSamplesRef.current.push({ at: now, bytes });
    bitrateSamplesRef.current = bitrateSamplesRef.current.filter((sample) => now - sample.at <= BITRATE_WINDOW_MS);
    const windowBytes = bitrateSamplesRef.current.reduce((total, sample) => total + sample.bytes, 0);
    const oldest = bitrateSamplesRef.current[0]?.at ?? now;
    const windowSeconds = Math.max(1, (now - oldest) / 1000);
    const bitrateKbps = Math.round((windowBytes * 8) / windowSeconds / 1000);
    setStats((current) => ({
      ...current,
      sentBytes: sentBytesRef.current,
      chunksSent: current.chunksSent + 1,
      lastChunkAt: now,
      updatedAt: now,
      bitrateKbps,
      bitrateHistory: [
        ...current.bitrateHistory,
        { at: now, kbps: bitrateKbps },
      ].filter((sample) => now - sample.at <= BITRATE_HISTORY_WINDOW_MS).slice(-60),
    }));
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearHeartbeatTimer = useCallback(() => {
    if (heartbeatTimerRef.current) {
      window.clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    pendingHeartbeatsRef.current.clear();
  }, []);

  const markRelayLatency = useCallback((sequence: number, sentAt: number) => {
    const pendingSentAt = pendingHeartbeatsRef.current.get(sequence);
    pendingHeartbeatsRef.current.delete(sequence);
    const latencyMs = getRelayLatencyMs(Date.now(), pendingSentAt ?? sentAt);
    if (latencyMs === null) return;
    setStats((current) => ({
      ...current,
      relayLatencyMs: latencyMs,
      updatedAt: Date.now(),
    }));
  }, []);

  const startHeartbeatTimer = useCallback((ws: WebSocket) => {
    clearHeartbeatTimer();
    const sendHeartbeat = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const sequence = heartbeatSequenceRef.current + 1;
      heartbeatSequenceRef.current = sequence;
      const sentAt = Date.now();
      pendingHeartbeatsRef.current.set(sequence, sentAt);
      const pending = Array.from(pendingHeartbeatsRef.current.keys());
      if (pending.length > MAX_PENDING_RELAY_PINGS) {
        pending.slice(0, pending.length - MAX_PENDING_RELAY_PINGS).forEach((key) => {
          pendingHeartbeatsRef.current.delete(key);
        });
      }
      try {
        ws.send(JSON.stringify({
          type: 'ping',
          payload: { sentAt, sequence },
        }));
      } catch {
        pendingHeartbeatsRef.current.delete(sequence);
      }
    };

    sendHeartbeat();
    heartbeatTimerRef.current = window.setInterval(sendHeartbeat, RELAY_HEARTBEAT_INTERVAL_MS);
  }, [clearHeartbeatTimer]);

  const stopActiveRelayTransport = useCallback((sendStop: boolean) => {
    clearHeartbeatTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // Recorder may already be stopping.
      }
    }
    recorderRef.current = null;

    const ws = wsRef.current;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (sendStop && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stop' }));
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'Relay stopped');
      }
    }
    wsRef.current = null;

    cleanupMixer(mixerRef.current);
    mixerRef.current = null;
  }, [clearHeartbeatTimer]);

  const cleanup = useCallback((status: RtmpRelayStats['status'] = 'idle') => {
    clearReconnectTimer();
    stopActiveRelayTransport(true);
    activeDestinationIdsRef.current = [];
    reconnectAttemptsRef.current = 0;
    resetStats(status);
  }, [clearReconnectTimer, resetStats, stopActiveRelayTransport]);

  const stopRelay = useCallback(() => {
    intentionalStopRef.current = true;
    cleanup();
  }, [cleanup]);

  const checkRelayReadiness = useCallback(async (): Promise<RtmpRelayReadiness> => {
    const checkId = readinessCheckIdRef.current + 1;
    readinessCheckIdRef.current = checkId;
    const mediaWsUrl = getMediaWsUrl();
    const checking: RtmpRelayReadiness = {
      status: 'checking',
      message: 'Checking media relay...',
      mediaWsUrl,
      checkedAt: Date.now(),
    };
    setReadiness(checking);

    const browserIssue = getBrowserRelayIssue();
    if (browserIssue) {
      const unavailable: RtmpRelayReadiness = {
        status: 'unavailable',
        message: browserIssue,
        mediaWsUrl,
        checkedAt: Date.now(),
      };
      if (readinessCheckIdRef.current === checkId) setReadiness(unavailable);
      return unavailable;
    }

    try {
      await probeRelayWebSocket(mediaWsUrl);
      const ready: RtmpRelayReadiness = {
        status: 'ready',
        message: 'Media relay is reachable.',
        mediaWsUrl,
        checkedAt: Date.now(),
      };
      if (readinessCheckIdRef.current === checkId) setReadiness(ready);
      return ready;
    } catch (err) {
      const unavailable: RtmpRelayReadiness = {
        status: 'unavailable',
        message: err instanceof Error ? err.message : 'Media relay is unavailable.',
        mediaWsUrl,
        checkedAt: Date.now(),
      };
      if (readinessCheckIdRef.current === checkId) setReadiness(unavailable);
      return unavailable;
    }
  }, []);

  const startRelay = useCallback(
    async ({ token, refreshToken, destinations, orientation, outputPreset }: StartRelayOptions): Promise<void> => {
      if (wsRef.current || reconnectTimerRef.current) {
        throw new Error('A live relay session is already active.');
      }
      if (destinations.length === 0) {
        throw new Error('At least one stream destination is required.');
      }

      const browserIssue = getBrowserRelayIssue();
      if (browserIssue) {
        throw new Error(browserIssue);
      }

      const compositeStream = compositeStreamRef.current;
      if (!compositeStream) {
        throw new Error('The composited studio stream is not ready.');
      }

      const mimeType = getRelayMimeType();
      if (!mimeType) {
        throw new Error('This browser does not support WebM recording for RTMP relay.');
      }

      const videoConfig = getRtmpRelayVideoConfig(orientation, outputPreset);
      activeDestinationIdsRef.current = destinations.map((destination) => destination.id);
      intentionalStopRef.current = false;
      reconnectAttemptsRef.current = 0;
      resetStats('connecting');

      let currentToken = token;
      let finalStopReported = false;

      const reportFinalStop = (message: string) => {
        if (finalStopReported || intentionalStopRef.current) return;
        finalStopReported = true;
        setRelayStatus('error');
        activeDestinationIdsRef.current.forEach((id) => {
          onDestinationStatus(id, 'error', message);
        });
        onRelayStopped?.(message);
        cleanup('error');
      };

      const connectRelay = async (connectionToken: string): Promise<void> => {
        const currentBrowserIssue = getBrowserRelayIssue();
        if (currentBrowserIssue) {
          throw new Error(currentBrowserIssue);
        }

        const currentCompositeStream = compositeStreamRef.current;
        if (!currentCompositeStream) {
          throw new Error('The composited studio stream is not ready.');
        }

        const initialParticipantVolumes = getDuckedParticipantVolumes({
          enabled: audioDuckingEnabled,
          participantVolumes,
          participantAudioLevels,
          participantIds: [
            ...(localParticipantId ? [localParticipantId] : []),
            ...remoteStreams.keys(),
          ],
        });
        const currentAuxiliaryAudioStream = ensureAuxiliaryAudioStream?.() ?? auxiliaryAudioStream ?? null;
        const mixer = await createMixedBroadcastStream(
          currentCompositeStream,
          videoConfig,
          localStream,
          localParticipantId,
          remoteStreams,
          screenStream,
          currentAuxiliaryAudioStream,
          initialParticipantVolumes
        );
        mixerRef.current = mixer;

        await new Promise<void>((resolve, reject) => {
          let started = false;
          let startTimeout: number | null = null;
          const ws = new WebSocket(getMediaWsUrl());
          ws.binaryType = 'arraybuffer';
          wsRef.current = ws;

          const clearStartTimeout = () => {
            if (startTimeout) {
              window.clearTimeout(startTimeout);
              startTimeout = null;
            }
          };

          const fail = (error: Error) => {
            clearStartTimeout();
            stopActiveRelayTransport(false);
            reject(error);
          };

          const scheduleReconnect = (message: string): boolean => {
            if (intentionalStopRef.current || finalStopReported) return false;
            const plan = getRelayReconnectPlan(
              reconnectAttemptsRef.current,
              message,
              MAX_RELAY_RECONNECT_ATTEMPTS
            );
            if (!plan) return false;

            reconnectAttemptsRef.current = plan.attempt;
            stopActiveRelayTransport(false);
            activeDestinationIdsRef.current.forEach((id) => {
              onDestinationStatus(id, 'connecting', plan.message);
            });
            setStats((current) => ({
              ...current,
              status: 'connecting',
              reconnectAttempts: plan.attempt,
              updatedAt: Date.now(),
            }));

            clearReconnectTimer();
            reconnectTimerRef.current = window.setTimeout(() => {
              reconnectTimerRef.current = null;
              void (async () => {
                try {
                  currentToken = refreshToken ? await refreshToken() : currentToken;
                  await connectRelay(currentToken);
                } catch (err) {
                  const retryMessage = err instanceof Error ? err.message : 'Unable to reconnect media relay.';
                  if (!scheduleReconnect(retryMessage)) {
                    reportFinalStop(retryMessage);
                  }
                }
              })();
            }, RELAY_RECONNECT_DELAY_MS);

            return true;
          };

          const handleUnexpectedStop = (message: string) => {
            if (!started || intentionalStopRef.current) return;
            if (!scheduleReconnect(message)) {
              reportFinalStop(message);
            }
          };

          startTimeout = window.setTimeout(() => {
            fail(new Error('Timed out while starting the RTMP relay.'));
          }, 12_000);

          const startRecorder = () => {
            const estimatedFramesPerChunk = estimateDroppedFrames(
              videoConfig.frameRate,
              RELAY_RECORDER_TIMESLICE_MS
            );
            const recorder = new MediaRecorder(mixer.stream, {
              mimeType,
              videoBitsPerSecond: videoConfig.videoBitsPerSecond,
              audioBitsPerSecond: RELAY_AUDIO.audioBitsPerSecond,
            });
            recorderRef.current = recorder;

            recorder.ondataavailable = (event) => {
              if (event.data.size === 0) return;
              if (ws.readyState !== WebSocket.OPEN) {
                markDroppedChunk(estimatedFramesPerChunk);
                return;
              }
              event.data.arrayBuffer()
                .then((buffer) => {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(buffer);
                    markChunkSent(buffer.byteLength);
                  } else {
                    markDroppedChunk(estimatedFramesPerChunk);
                  }
                })
                .catch((err) => console.error('Failed to send RTMP relay chunk:', err));
            };

            recorder.onerror = () => {
              setRelayStatus('error');
              activeDestinationIdsRef.current.forEach((id) => {
                onDestinationStatus(id, 'error', 'Browser recording failed.');
              });
            };

            recorder.start(RELAY_RECORDER_TIMESLICE_MS);
          };

          ws.onopen = () => {
            ws.send(JSON.stringify({
              type: 'start',
              payload: {
                token: connectionToken,
                destinations,
                video: videoConfig,
                audio: RELAY_AUDIO,
              },
            }));
          };

          ws.onmessage = (event) => {
            let message: RtmpRelayServerMessage;
            try {
              message = JSON.parse(String(event.data)) as RtmpRelayServerMessage;
            } catch {
              return;
            }

            if (message.type === 'session-started') {
              clearStartTimeout();
              started = true;
              setRelayStatus('live');
              startHeartbeatTimer(ws);
              startRecorder();
              resolve();
              return;
            }

            if (message.type === 'session-stopped') {
              const stopMessage = message.payload.reason
                ? `Media relay stopped: ${message.payload.reason}`
                : 'Media relay stopped unexpectedly.';
              if (!started) {
                fail(new Error(stopMessage));
                return;
              }
              handleUnexpectedStop(stopMessage);
              return;
            }

            if (message.type === 'destination-status') {
              if (message.payload.status === 'error') setRelayStatus('error');
              if (message.payload.status === 'live') setRelayStatus('live');
              onDestinationStatus(
                message.payload.destinationId,
                message.payload.status,
                message.payload.message
              );
              return;
            }

            if (message.type === 'pong') {
              markRelayLatency(message.payload.sequence, message.payload.sentAt);
              return;
            }

            if (message.type === 'error') {
              setRelayStatus('error');
              if (message.payload.destinationId) {
                onDestinationStatus(message.payload.destinationId, 'error', message.payload.message);
              }
              if (!started) {
                fail(new Error(message.payload.message));
              }
            }
          };

          ws.onerror = () => {
            if (!started) {
              setRelayStatus('error');
              fail(new Error('Unable to connect to the RTMP relay server.'));
            }
          };

          ws.onclose = () => {
            clearStartTimeout();
            if (!started) {
              reject(new Error('The RTMP relay connection closed before streaming started.'));
              stopActiveRelayTransport(false);
              setRelayStatus('error');
              return;
            }
            if (!intentionalStopRef.current) {
              handleUnexpectedStop('Media relay connection closed unexpectedly.');
            }
          };
        });
      };

      await connectRelay(currentToken);
    },
    [audioDuckingEnabled, auxiliaryAudioStream, cleanup, clearReconnectTimer, compositeStreamRef, ensureAuxiliaryAudioStream, localParticipantId, localStream, markChunkSent, markDroppedChunk, markRelayLatency, onDestinationStatus, onRelayStopped, participantAudioLevels, participantVolumes, remoteStreams, resetStats, screenStream, setRelayStatus, startHeartbeatTimer, stopActiveRelayTransport]
  );

  useEffect(() => {
    if (!readinessEnabled) return;
    if (wsRef.current || stats.status !== 'idle') return;
    void checkRelayReadiness();
  }, [checkRelayReadiness, readinessEnabled, stats.status]);

  useEffect(() => {
    const mixer = mixerRef.current;
    if (!mixer) return;
    const effectiveVolumes = getDuckedParticipantVolumes({
      enabled: audioDuckingEnabled,
      participantVolumes,
      participantAudioLevels,
      participantIds: mixer.participantGains.keys(),
    });
    for (const [participantId, gain] of mixer.participantGains) {
      gain.gain.setTargetAtTime(
        clampVolume(effectiveVolumes[participantId]),
        mixer.audioContext.currentTime,
        0.08
      );
    }
  }, [audioDuckingEnabled, participantAudioLevels, participantVolumes]);

  useEffect(() => {
    if (stats.status === 'idle') return;
    const timer = window.setInterval(() => {
      setStats((current) => (
        current.status === 'idle' ? current : { ...current, updatedAt: Date.now() }
      ));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [stats.status]);

  useEffect(() => cleanup, [cleanup]);

  return { startRelay, stopRelay, stats, readiness, checkRelayReadiness };
}
