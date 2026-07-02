import { useEffect, useMemo, useState } from 'react';
import {
  detectBrowserVideoEncodingReadiness,
  getInitialVideoEncodingReadiness,
  type VideoEncodingReadiness,
  type VideoEncodingReadinessStatus,
} from '../utils/videoEncodingCapabilities.ts';
import {
  buildSessionPeerHealthSummary,
  type SessionPeerHealthParticipant,
  type SessionPeerHealthSummary,
} from '../utils/sessionPeerHealth.ts';
import {
  DEFAULT_ICE_CONFIG_STATUS,
  fetchIceConfigWithStatus,
  type ClientIceConfigStatus,
} from '../utils/iceConfig.ts';

export type HealthStatus = 'good' | 'warning' | 'bad';

export interface SessionHealthCheck {
  id: string;
  label: string;
  status: HealthStatus;
  detail: string;
}

export interface SessionHealthSummary {
  status: HealthStatus;
  label: string;
  score: number;
  checks: SessionHealthCheck[];
  storage: {
    supported: boolean;
    usage: number | null;
    quota: number | null;
    percentUsed: number | null;
  };
  network: {
    online: boolean;
    effectiveType?: string;
    downlink?: number;
    rtt?: number;
  };
  media: {
    audioTrack: MediaStreamTrack | null;
    videoTrack: MediaStreamTrack | null;
    videoLabel: string;
    audioLabel: string;
  };
  encoding: VideoEncodingReadiness;
  ice: ClientIceConfigStatus;
  peerConnections: SessionPeerHealthSummary;
}

interface NetworkInformationLike extends EventTarget {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
}

interface UseSessionHealthOptions {
  localStream: MediaStream | null;
  connected: boolean;
  mediaError: string | null;
  audioDeviceCount: number;
  videoDeviceCount: number;
  participantCount: number;
  peerConnectionParticipants?: SessionPeerHealthParticipant[];
  isRecording: boolean;
  isLive: boolean;
}

function getNetworkInfo() {
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  return {
    online: navigator.onLine,
    effectiveType: connection?.effectiveType,
    downlink: connection?.downlink,
    rtt: connection?.rtt,
  };
}

function formatVideoLabel(track: MediaStreamTrack | null): string {
  if (!track) return 'No camera track';
  const settings = track.getSettings();
  const width = settings.width;
  const height = settings.height;
  const frameRate = settings.frameRate;
  if (width && height && frameRate) return `${width}x${height} at ${Math.round(frameRate)} fps`;
  if (width && height) return `${width}x${height}`;
  return track.enabled ? 'Camera ready' : 'Camera off';
}

function formatAudioLabel(track: MediaStreamTrack | null): string {
  if (!track) return 'No microphone track';
  const settings = track.getSettings();
  if (settings.sampleRate) return `${settings.sampleRate} Hz`;
  return track.enabled ? 'Microphone ready' : 'Microphone muted';
}

function scoreForStatus(status: HealthStatus): number {
  switch (status) {
    case 'good': return 100;
    case 'warning': return 58;
    case 'bad': return 0;
  }
}

function statusFromScore(score: number): HealthStatus {
  if (score >= 80) return 'good';
  if (score >= 50) return 'warning';
  return 'bad';
}

function labelFromStatus(status: HealthStatus): string {
  switch (status) {
    case 'good': return 'Ready';
    case 'warning': return 'Needs attention';
    case 'bad': return 'Blocked';
  }
}

function healthStatusFromEncoding(status: VideoEncodingReadinessStatus): HealthStatus {
  switch (status) {
    case 'ready': return 'good';
    case 'limited': return 'warning';
    case 'unsupported': return 'bad';
  }
}

function healthStatusFromIceStatus(status: ClientIceConfigStatus): HealthStatus {
  if (status.turnReady) return 'good';
  if (status.hasTurn) return 'warning';
  return 'bad';
}

function iceSourceLabel(source: ClientIceConfigStatus['source']): string {
  switch (source) {
    case 'ice_servers_json': return 'ICE_SERVERS_JSON';
    case 'split_env': return 'TURN_URLS';
    case 'default': return 'fallback';
    default: return 'server';
  }
}

function formatIceStatusDetail(status: ClientIceConfigStatus): string {
  if (status.turnReady) {
    return `${status.turnServerCount} production TURN relay${status.turnServerCount === 1 ? '' : 's'} configured from ${iceSourceLabel(status.source)}.`;
  }
  if (status.usingFallbackTurn) {
    return 'Using fallback TURN relays. Configure production TURN credentials on Render for more reliable guest connectivity.';
  }
  if (status.hasTurn) {
    return 'TURN URLs are present, but production TURN credentials were not confirmed.';
  }
  return 'No TURN relay is configured; guests behind strict networks may fail to connect.';
}

export function useSessionHealth({
  localStream,
  connected,
  mediaError,
  audioDeviceCount,
  videoDeviceCount,
  participantCount,
  peerConnectionParticipants = [],
  isRecording,
  isLive,
}: UseSessionHealthOptions): SessionHealthSummary {
  const [network, setNetwork] = useState(getNetworkInfo);
  const [storage, setStorage] = useState<SessionHealthSummary['storage']>({
    supported: Boolean(navigator.storage?.estimate),
    usage: null,
    quota: null,
    percentUsed: null,
  });
  const [encoding, setEncoding] = useState<VideoEncodingReadiness>(() => getInitialVideoEncodingReadiness());
  const [iceStatus, setIceStatus] = useState<ClientIceConfigStatus>(() => DEFAULT_ICE_CONFIG_STATUS);

  useEffect(() => {
    const update = () => setNetwork(getNetworkInfo());
    const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    connection?.addEventListener?.('change', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      connection?.removeEventListener?.('change', update);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const updateStorage = async () => {
      if (!navigator.storage?.estimate) {
        setStorage({ supported: false, usage: null, quota: null, percentUsed: null });
        return;
      }
      const estimate = await navigator.storage.estimate();
      if (cancelled) return;
      const usage = estimate.usage ?? null;
      const quota = estimate.quota ?? null;
      setStorage({
        supported: true,
        usage,
        quota,
        percentUsed: usage !== null && quota ? Math.round((usage / quota) * 100) : null,
      });
    };
    updateStorage();
    const timer = window.setInterval(updateStorage, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isRecording]);

  useEffect(() => {
    let cancelled = false;
    detectBrowserVideoEncodingReadiness()
      .then((readiness) => {
        if (!cancelled) setEncoding(readiness);
      })
      .catch(() => {
        if (!cancelled) setEncoding(getInitialVideoEncodingReadiness());
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchIceConfigWithStatus()
      .then(({ status }) => {
        if (!cancelled) setIceStatus(status);
      })
      .catch(() => {
        if (!cancelled) setIceStatus(DEFAULT_ICE_CONFIG_STATUS);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => {
    const audioTrack = localStream?.getAudioTracks()[0] ?? null;
    const videoTrack = localStream?.getVideoTracks()[0] ?? null;
    const checks: SessionHealthCheck[] = [];
    const peerConnections = buildSessionPeerHealthSummary(peerConnectionParticipants);

    const mediaApiReady = Boolean(navigator.mediaDevices?.getUserMedia);
    checks.push({
      id: 'browser-media',
      label: 'Browser media',
      status: mediaApiReady && typeof MediaRecorder !== 'undefined' ? 'good' : 'bad',
      detail: mediaApiReady && typeof MediaRecorder !== 'undefined'
        ? 'Camera, microphone, and recording APIs are available.'
        : 'Use a modern browser on HTTPS or localhost.',
    });

    checks.push({
      id: 'encoding',
      label: 'Browser encoder',
      status: healthStatusFromEncoding(encoding.status),
      detail: encoding.detail,
    });

    checks.push({
      id: 'signaling',
      label: 'Studio connection',
      status: connected ? 'good' : 'bad',
      detail: connected ? 'Connected to the studio signaling server.' : 'Not connected to the studio server.',
    });

    checks.push({
      id: 'turn-relay',
      label: 'TURN relay',
      status: healthStatusFromIceStatus(iceStatus),
      detail: formatIceStatusDetail(iceStatus),
    });

    const networkStatus: HealthStatus = !network.online
      ? 'bad'
      : network.effectiveType && ['slow-2g', '2g'].includes(network.effectiveType)
        ? 'warning'
        : 'good';
    checks.push({
      id: 'network',
      label: 'Network',
      status: networkStatus,
      detail: !network.online
        ? 'Browser reports that you are offline.'
        : network.effectiveType
          ? `${network.effectiveType.toUpperCase()}${network.downlink ? `, ${network.downlink} Mbps` : ''}${network.rtt ? `, ${network.rtt} ms RTT` : ''}`
          : 'Online. Detailed network metrics are not exposed by this browser.',
    });

    const audioStatus: HealthStatus = mediaError && !audioTrack ? 'bad' : audioTrack ? 'good' : audioDeviceCount > 0 ? 'warning' : 'bad';
    checks.push({
      id: 'audio',
      label: 'Microphone',
      status: audioStatus,
      detail: audioTrack ? formatAudioLabel(audioTrack) : audioDeviceCount > 0 ? 'Microphone available but not active.' : 'No microphone detected.',
    });

    const videoStatus: HealthStatus = mediaError && !videoTrack ? 'bad' : videoTrack ? 'good' : videoDeviceCount > 0 ? 'warning' : 'bad';
    checks.push({
      id: 'video',
      label: 'Camera',
      status: videoStatus,
      detail: videoTrack ? formatVideoLabel(videoTrack) : videoDeviceCount > 0 ? 'Camera available but not active.' : 'No camera detected.',
    });

    const storageStatus: HealthStatus = !storage.supported
      ? 'warning'
      : storage.percentUsed !== null && storage.percentUsed > 90
        ? 'bad'
        : storage.percentUsed !== null && storage.percentUsed > 75
          ? 'warning'
          : 'good';
    checks.push({
      id: 'storage',
      label: 'Recording storage',
      status: storageStatus,
      detail: storage.supported
        ? storage.percentUsed !== null
          ? `${storage.percentUsed}% of browser storage is in use.`
          : 'Storage estimate is available.'
        : 'Browser storage estimate is unavailable; long local recordings may be riskier.',
    });

    checks.push({
      id: 'capacity',
      label: 'Session capacity',
      status: participantCount <= 5 ? 'good' : participantCount <= 7 ? 'warning' : 'bad',
      detail: participantCount <= 5
        ? `${participantCount} participant${participantCount === 1 ? '' : 's'} in this mesh session.`
        : 'Mesh WebRTC sessions become fragile as participant count rises.',
    });

    checks.push({
      id: 'participant-connections',
      label: 'Guest connections',
      status: peerConnections.status,
      detail: peerConnections.detail,
    });

    if (mediaError) {
      checks.push({
        id: 'media-error',
        label: 'Media warning',
        status: 'warning',
        detail: mediaError,
      });
    }

    if (isLive || isRecording) {
      checks.push({
        id: 'production-state',
        label: 'Production state',
        status: connected && network.online ? 'good' : 'bad',
        detail: isLive && isRecording
          ? 'Live and recording are both active.'
          : isLive
            ? 'Live output is active.'
            : 'Recording is active.',
      });
    }

    const score = Math.round(checks.reduce((sum, check) => sum + scoreForStatus(check.status), 0) / checks.length);
    const status = statusFromScore(score);

    return {
      status,
      label: labelFromStatus(status),
      score,
      checks,
      storage,
      network,
      media: {
        audioTrack,
        videoTrack,
        audioLabel: formatAudioLabel(audioTrack),
        videoLabel: formatVideoLabel(videoTrack),
      },
      encoding,
      ice: iceStatus,
      peerConnections,
    };
  }, [
    audioDeviceCount,
    connected,
    encoding,
    iceStatus,
    isLive,
    isRecording,
    localStream,
    mediaError,
    network,
    participantCount,
    peerConnectionParticipants,
    storage,
    videoDeviceCount,
  ]);
}
