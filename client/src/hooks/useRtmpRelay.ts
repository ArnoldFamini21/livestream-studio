import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BroadcastOrientation,
  RtmpRelayDestination,
  RtmpRelayDestinationStatus,
  RtmpRelayServerMessage,
  RtmpRelayVideoConfig,
} from '@studio/shared';
import { resolveMediaWsUrl } from '../utils/apiClient.ts';

interface UseRtmpRelayOptions {
  compositeStreamRef: React.MutableRefObject<MediaStream | null>;
  localStream: MediaStream | null;
  localParticipantId?: string | null;
  remoteStreams: Map<string, MediaStream>;
  screenStream: MediaStream | null;
  participantVolumes?: Record<string, number>;
  readinessEnabled?: boolean;
  onDestinationStatus: (destinationId: string, status: RtmpRelayDestinationStatus, message?: string) => void;
  onRelayStopped?: (message: string) => void;
}

interface StartRelayOptions {
  token: string;
  destinations: RtmpRelayDestination[];
  orientation: BroadcastOrientation;
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

const RELAY_VIDEO = {
  frameRate: 30,
  videoBitsPerSecond: 4_500_000,
};

const RELAY_VIDEO_BY_ORIENTATION: Record<BroadcastOrientation, RtmpRelayVideoConfig> = {
  landscape: {
    width: 1920,
    height: 1080,
    ...RELAY_VIDEO,
  },
  portrait: {
    width: 1080,
    height: 1920,
    ...RELAY_VIDEO,
  },
};

const RELAY_AUDIO = {
  sampleRate: 48_000,
  channelCount: 2,
  audioBitsPerSecond: 160_000,
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
};

const BITRATE_WINDOW_MS = 5_000;
const BITRATE_HISTORY_WINDOW_MS = 60_000;
const RELAY_PREFLIGHT_TIMEOUT_MS = 4_000;

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
  participantVolumes: Record<string, number>
): Array<{ stream: MediaStream; volume: number; participantId?: string }> {
  const sources: Array<{ stream: MediaStream; volume: number; participantId?: string }> = [];
  if (localStream?.getAudioTracks().some((track) => track.readyState === 'live')) {
    sources.push({
      stream: new MediaStream(localStream.getAudioTracks()),
      volume: localParticipantId ? clampVolume(participantVolumes[localParticipantId]) : 1,
      participantId: localParticipantId || undefined,
    });
  }
  for (const [participantId, stream] of remoteStreams) {
    const audioTracks = stream.getAudioTracks().filter((track) => track.readyState === 'live');
    if (audioTracks.length > 0) {
      sources.push({
        stream: new MediaStream(audioTracks),
        volume: clampVolume(participantVolumes[participantId]),
        participantId,
      });
    }
  }
  const screenAudioTracks = screenStream?.getAudioTracks().filter((track) => track.readyState === 'live') || [];
  if (screenAudioTracks.length > 0) sources.push({ stream: new MediaStream(screenAudioTracks), volume: 1 });
  return sources;
}

function getRelayVideoConfig(orientation: BroadcastOrientation): RtmpRelayVideoConfig {
  return RELAY_VIDEO_BY_ORIENTATION[orientation] || RELAY_VIDEO_BY_ORIENTATION.landscape;
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
  const audioSources = collectAudioSources(localStream, localParticipantId, remoteStreams, screenStream, participantVolumes);

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
  participantVolumes = {},
  readinessEnabled = true,
  onDestinationStatus,
  onRelayStopped,
}: UseRtmpRelayOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const mixerRef = useRef<MixerResources | null>(null);
  const activeDestinationIdsRef = useRef<string[]>([]);
  const intentionalStopRef = useRef(false);
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

  const markDroppedChunk = useCallback(() => {
    setStats((current) => ({
      ...current,
      droppedChunks: current.droppedChunks + 1,
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

  const cleanup = useCallback((status: RtmpRelayStats['status'] = 'idle') => {
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
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
      ws.close(1000, 'Relay stopped');
    } else if (ws && ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, 'Relay stopped');
    }
    wsRef.current = null;

    cleanupMixer(mixerRef.current);
    mixerRef.current = null;
    activeDestinationIdsRef.current = [];
    resetStats(status);
  }, [resetStats]);

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
    async ({ token, destinations, orientation }: StartRelayOptions): Promise<void> => {
      if (wsRef.current) {
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

      const videoConfig = getRelayVideoConfig(orientation);
      const mixer = await createMixedBroadcastStream(
        compositeStream,
        videoConfig,
        localStream,
        localParticipantId,
        remoteStreams,
        screenStream,
        participantVolumes
      );
      mixerRef.current = mixer;
      activeDestinationIdsRef.current = destinations.map((destination) => destination.id);
      intentionalStopRef.current = false;
      resetStats('connecting');

      await new Promise<void>((resolve, reject) => {
        let started = false;
        let stopReported = false;
        const ws = new WebSocket(getMediaWsUrl());
        ws.binaryType = 'arraybuffer';
        wsRef.current = ws;

        const fail = (error: Error) => {
          cleanup('error');
          reject(error);
        };

        const reportUnexpectedStop = (message: string) => {
          if (!started || stopReported || intentionalStopRef.current) return;
          stopReported = true;
          setRelayStatus('error');
          activeDestinationIdsRef.current.forEach((id) => {
            onDestinationStatus(id, 'error', message);
          });
          onRelayStopped?.(message);
        };

        const startTimeout = window.setTimeout(() => {
          fail(new Error('Timed out while starting the RTMP relay.'));
        }, 12_000);

        const startRecorder = () => {
          const recorder = new MediaRecorder(mixer.stream, {
            mimeType,
            videoBitsPerSecond: videoConfig.videoBitsPerSecond,
            audioBitsPerSecond: RELAY_AUDIO.audioBitsPerSecond,
          });
          recorderRef.current = recorder;

          recorder.ondataavailable = (event) => {
            if (event.data.size === 0) return;
            if (ws.readyState !== WebSocket.OPEN) {
              markDroppedChunk();
              return;
            }
            event.data.arrayBuffer()
              .then((buffer) => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(buffer);
                  markChunkSent(buffer.byteLength);
                } else {
                  markDroppedChunk();
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

          recorder.start(1000);
        };

        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: 'start',
            payload: {
              token,
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
            window.clearTimeout(startTimeout);
            started = true;
            setRelayStatus('live');
            startRecorder();
            resolve();
            return;
          }

          if (message.type === 'session-stopped') {
            const stopMessage = message.payload.reason
              ? `Media relay stopped: ${message.payload.reason}`
              : 'Media relay stopped unexpectedly.';
            if (!started) {
              window.clearTimeout(startTimeout);
              fail(new Error(stopMessage));
              return;
            }
            reportUnexpectedStop(stopMessage);
            cleanup(intentionalStopRef.current ? 'idle' : 'error');
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

          if (message.type === 'error') {
            setRelayStatus('error');
            if (message.payload.destinationId) {
              onDestinationStatus(message.payload.destinationId, 'error', message.payload.message);
            }
            if (!started) {
              window.clearTimeout(startTimeout);
              fail(new Error(message.payload.message));
            }
          }
        };

        ws.onerror = () => {
          if (!started) {
            window.clearTimeout(startTimeout);
            setRelayStatus('error');
            fail(new Error('Unable to connect to the RTMP relay server.'));
          }
        };

        ws.onclose = () => {
          window.clearTimeout(startTimeout);
          if (!started) {
            reject(new Error('The RTMP relay connection closed before streaming started.'));
            cleanupMixer(mixerRef.current);
            mixerRef.current = null;
            setRelayStatus('error');
            wsRef.current = null;
            activeDestinationIdsRef.current = [];
            return;
          }
          if (!intentionalStopRef.current) {
            reportUnexpectedStop('Media relay connection closed unexpectedly.');
            cleanup('error');
          }
        };
      });
    },
    [cleanup, compositeStreamRef, localParticipantId, localStream, markChunkSent, markDroppedChunk, onDestinationStatus, onRelayStopped, participantVolumes, remoteStreams, resetStats, screenStream, setRelayStatus]
  );

  useEffect(() => {
    if (!readinessEnabled) return;
    if (wsRef.current || stats.status !== 'idle') return;
    void checkRelayReadiness();
  }, [checkRelayReadiness, readinessEnabled, stats.status]);

  useEffect(() => {
    const mixer = mixerRef.current;
    if (!mixer) return;
    for (const [participantId, gain] of mixer.participantGains) {
      gain.gain.setTargetAtTime(
        clampVolume(participantVolumes[participantId]),
        mixer.audioContext.currentTime,
        0.03
      );
    }
  }, [participantVolumes]);

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
