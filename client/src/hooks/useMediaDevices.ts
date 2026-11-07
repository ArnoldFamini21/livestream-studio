import { useState, useCallback, useRef, useEffect } from 'react';
import {
  createAudioTrackConstraints,
  normalizeAudioProcessingPreferences,
} from '../utils/audioProcessing.ts';
import {
  createEnhancedAudioStream,
  type EnhancedAudioStream,
} from '../utils/audioEnhancement.ts';
import { replaceFallbackMediaTrack } from '../utils/mediaDeviceFallback.ts';
import {
  createMediaAccessProblem,
  isMediaPermissionBlock,
  isTransientMediaAccessError,
  withMediaAccessDevice,
  type MediaAccessProblem,
} from '../utils/mediaAccessErrors.ts';
import {
  createVideoTrackConstraints,
  getRecommendedVideoQualityPresetId,
  readPreferredAudioProcessing,
  readPreferredVideoQuality,
  writePreferredAudioProcessing,
  writePreferredVideoQuality,
  type AudioProcessingPreferences,
  type VideoQualityPresetId,
} from '../utils/mediaPreferences.ts';

export interface MediaDeviceInfo {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'videoinput' | 'audiooutput';
}

// Type for the setSinkId API which may or may not be present on HTMLMediaElement
interface SinkIdElement {
  setSinkId?: (sinkId: string) => Promise<void>;
}

export interface StartMediaOptions extends Partial<AudioProcessingPreferences> {
  audioEnabled?: boolean;
  videoEnabled?: boolean;
  videoQuality?: VideoQualityPresetId;
  /**
   * When a device fails for a reason other than a blocked permission, wait
   * this long and try once more. Safari often fails right after the previous
   * page's preview stream on the same camera stopped.
   */
  retryDelayMs?: number;
}

type AcquireResult =
  | { stream: MediaStream; problem: MediaAccessProblem | null; usedFallback: boolean }
  | { stream: null; problem: MediaAccessProblem; usedFallback: false };

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function liveTrackCount(stream: MediaStream | null): number {
  return stream ? stream.getTracks().filter((track) => track.readyState === 'live').length : 0;
}

export function useMediaDevices() {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // What exactly failed (blocked, busy, missing) so the page can show how to fix it.
  const [errorProblem, setErrorProblemState] = useState<MediaAccessProblem | null>(null);
  const errorProblemRef = useRef<MediaAccessProblem | null>(null);
  const setErrorProblem = useCallback((problem: MediaAccessProblem | null) => {
    errorProblemRef.current = problem;
    setErrorProblemState(problem);
  }, []);
  const lastStartOptionsRef = useRef<StartMediaOptions>({});

  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioProcessing, setAudioProcessing] = useState<AudioProcessingPreferences>(() => readPreferredAudioProcessing());
  const [videoQuality, setVideoQuality] = useState<VideoQualityPresetId>(() => readPreferredVideoQuality());
  const [recommendedVideoQuality] = useState<VideoQualityPresetId>(() => getRecommendedVideoQualityPresetId());

  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState<string>(() => localStorage.getItem('preferredAudioDeviceId') || '');
  const [selectedVideoDeviceId, setSelectedVideoDeviceId] = useState<string>(() => localStorage.getItem('preferredVideoDeviceId') || '');
  const [selectedAudioOutputDeviceId, setSelectedAudioOutputDeviceId] = useState<string>(() => localStorage.getItem('preferredAudioOutputDeviceId') || '');

  const streamRef = useRef<MediaStream | null>(null);
  const enhancedAudioRef = useRef<EnhancedAudioStream | null>(null);
  const switchingRef = useRef(false);
  const audioOutputIdRef = useRef<string>(selectedAudioOutputDeviceId);
  const audioProcessingOptionsRef = useRef<AudioProcessingPreferences>(readPreferredAudioProcessing());
  const videoQualityRef = useRef<VideoQualityPresetId>(readPreferredVideoQuality());

  const publishStreamUpdate = useCallback(() => {
    if (!streamRef.current) {
      setLocalStream(null);
      return;
    }
    setLocalStream(new MediaStream(streamRef.current.getTracks()));
  }, []);

  const cleanupEnhancedAudio = useCallback((options: { stopSource?: boolean } = {}) => {
    enhancedAudioRef.current?.cleanup(options);
    enhancedAudioRef.current = null;
  }, []);

  const stopCurrentStream = useCallback(() => {
    cleanupEnhancedAudio({ stopSource: true });
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setLocalStream(null);
  }, [cleanupEnhancedAudio]);

  useEffect(() => {
    audioOutputIdRef.current = selectedAudioOutputDeviceId;
  }, [selectedAudioOutputDeviceId]);

  // Enumerate all available media devices
  const enumerateDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return { audio: [], video: [], audioOut: [] };
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();

      const audio: MediaDeviceInfo[] = [];
      const video: MediaDeviceInfo[] = [];
      const audioOut: MediaDeviceInfo[] = [];

      devices.forEach((device, index) => {
        const info: MediaDeviceInfo = {
          deviceId: device.deviceId,
          label: device.label || `${device.kind} ${index + 1}`,
          kind: device.kind as MediaDeviceInfo['kind'],
        };

        switch (device.kind) {
          case 'audioinput':
            audio.push(info);
            break;
          case 'videoinput':
            video.push(info);
            break;
          case 'audiooutput':
            audioOut.push(info);
            break;
        }
      });

      setAudioDevices(audio);
      setVideoDevices(video);
      setAudioOutputDevices(audioOut);

      return { audio, video, audioOut };
    } catch (err) {
      console.error('Failed to enumerate devices:', err);
      return { audio: [], video: [], audioOut: [] };
    }
  }, []);

  // Start media with optional specific device IDs
  const startMedia = useCallback(async (
    audioDeviceId?: string, 
    videoDeviceId?: string,
    options: StartMediaOptions = { echoCancellation: true, noiseSuppression: true }
  ) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Media devices not available. Please use HTTPS or localhost.');
      setErrorProblem({ kind: 'insecure-context', device: 'both', message: 'Camera and microphone are not available here. Open the studio link over https.' });
      return null;
    }
    lastStartOptionsRef.current = { ...options };

    try {
      const nextAudioProcessing = normalizeAudioProcessingPreferences(options);
      const nextVideoQuality = options.videoQuality || videoQualityRef.current;
      audioProcessingOptionsRef.current = nextAudioProcessing;
      videoQualityRef.current = nextVideoQuality;
      setAudioProcessing(nextAudioProcessing);
      setVideoQuality(nextVideoQuality);
      writePreferredAudioProcessing(nextAudioProcessing);
      writePreferredVideoQuality(nextVideoQuality);
      // Stop any existing tracks first
      stopCurrentStream();

      const targetVideoId = videoDeviceId || localStorage.getItem('preferredVideoDeviceId');
      const targetAudioId = audioDeviceId || localStorage.getItem('preferredAudioDeviceId');

      const createVideoConstraints = (deviceId?: string | null): MediaTrackConstraints => (
        createVideoTrackConstraints(deviceId, nextVideoQuality)
      );
      const createAudioConstraints = (deviceId?: string | null) => createAudioTrackConstraints(deviceId, nextAudioProcessing);

      const preferredDeviceIds = [targetAudioId, targetVideoId].some(Boolean);
      const avAttempts: MediaStreamConstraints[] = [
        { audio: createAudioConstraints(targetAudioId), video: createVideoConstraints(targetVideoId) },
        ...(preferredDeviceIds ? [{ audio: createAudioConstraints(), video: createVideoConstraints() }] : []),
      ];
      const audioOnlyAttempts: MediaStreamConstraints[] = [
        { audio: createAudioConstraints(targetAudioId), video: false },
        ...(targetAudioId ? [{ audio: createAudioConstraints(), video: false }] : []),
      ];
      const videoOnlyAttempts: MediaStreamConstraints[] = [
        { audio: false, video: createVideoConstraints(targetVideoId) },
        ...(targetVideoId ? [{ audio: false, video: createVideoConstraints() }] : []),
      ];

      const tryMediaAttempts = async (attempts: MediaStreamConstraints[]) => {
        let lastError: unknown;
        for (let index = 0; index < attempts.length; index++) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia(attempts[index]);
            // A stream whose tracks already ended is as good as a failure (seen in Safari).
            if (liveTrackCount(stream) === 0) {
              stream.getTracks().forEach((track) => track.stop());
              throw new DOMException('The device stopped as soon as it started.', 'NotReadableError');
            }
            return { stream, usedFallback: index > 0 };
          } catch (err) {
            lastError = err;
            // Another device id will not lift a blocked permission.
            if (isMediaPermissionBlock(err)) break;
          }
        }
        throw lastError;
      };

      // Camera and mic together, then each alone. The error that is kept is
      // the one that explains the problem, never a generic "no devices".
      const acquire = async (): Promise<AcquireResult> => {
        let avError: unknown;
        try {
          const result = await tryMediaAttempts(avAttempts);
          return { stream: result.stream, problem: null, usedFallback: result.usedFallback };
        } catch (err) {
          avError = err;
        }
        // Asking again for a blocked permission only re-prompts (Safari) or fails again.
        if (isMediaPermissionBlock(avError)) {
          return { stream: null, problem: createMediaAccessProblem(avError, 'both'), usedFallback: false };
        }
        let audioError: unknown;
        try {
          const result = await tryMediaAttempts(audioOnlyAttempts);
          return { stream: result.stream, problem: createMediaAccessProblem(avError, 'camera'), usedFallback: false };
        } catch (err) {
          audioError = err;
        }
        try {
          const result = await tryMediaAttempts(videoOnlyAttempts);
          return { stream: result.stream, problem: createMediaAccessProblem(audioError, 'microphone'), usedFallback: false };
        } catch {
          return { stream: null, problem: createMediaAccessProblem(avError, 'both'), usedFallback: false };
        }
      };

      let acquired = await acquire();
      if (
        acquired.problem &&
        options.retryDelayMs &&
        isTransientMediaAccessError(acquired.problem.kind)
      ) {
        // One more try after a short pause before telling the user anything.
        await sleep(options.retryDelayMs);
        // Release a partial stream first: Safari ends a track when the same device is requested again.
        const hadPartialStream = Boolean(acquired.stream);
        acquired.stream?.getTracks().forEach((track) => track.stop());
        acquired = await acquire();
        // If the retry got nothing, take back the devices that did work the first time.
        if (!acquired.stream && hadPartialStream) acquired = await acquire();
      }

      if (!acquired.stream) {
        setError(acquired.problem.message);
        setErrorProblem(acquired.problem);
        setAudioEnabled(false);
        setVideoEnabled(false);
        stopCurrentStream();
        return null;
      }
      let stream: MediaStream = acquired.stream;
      setErrorProblem(acquired.problem);
      setError(acquired.problem
        ? acquired.problem.message
        : acquired.usedFallback ? 'Preferred device unavailable - using available camera and microphone' : null);
      const enhancedAudio = createEnhancedAudioStream(stream, nextAudioProcessing);
      stream = enhancedAudio.stream;
      enhancedAudioRef.current = enhancedAudio.enhanced ? enhancedAudio : null;
      // Track which devices are actually active
      const activeAudioTrack = stream.getAudioTracks()[0];
      const activeSourceAudioTrack = enhancedAudio.sourceTrack || activeAudioTrack;
      const activeVideoTrack = stream.getVideoTracks()[0];
      if (activeAudioTrack) {
        const nextEnabled = options.audioEnabled ?? true;
        activeAudioTrack.enabled = nextEnabled;
        if (activeSourceAudioTrack && activeSourceAudioTrack !== activeAudioTrack) {
          activeSourceAudioTrack.enabled = nextEnabled;
        }
      }
      if (activeVideoTrack) activeVideoTrack.enabled = options.videoEnabled ?? true;
      setAudioEnabled(Boolean(activeAudioTrack?.enabled));
      setVideoEnabled(Boolean(activeVideoTrack?.enabled));

      // Apply privacy choices before the stream can be rendered or published.
      streamRef.current = stream;
      setLocalStream(stream);
      await enumerateDevices();

      if (activeAudioTrack) {
        const settings = (activeSourceAudioTrack || activeAudioTrack).getSettings();
        const activeId = settings.deviceId || '';
        setSelectedAudioDeviceId(activeId);
        if (activeId) localStorage.setItem('preferredAudioDeviceId', activeId);

        // Bug fix #15: Add track.onended listener for audio
        (activeSourceAudioTrack || activeAudioTrack).onended = () => {
          setAudioEnabled(false);
          setError('Audio device disconnected unexpectedly');
        };
      }
      if (activeVideoTrack) {
        const settings = activeVideoTrack.getSettings();
        const activeId = settings.deviceId || '';
        setSelectedVideoDeviceId(activeId);
        if (activeId) localStorage.setItem('preferredVideoDeviceId', activeId);

        // Bug fix #15: Add track.onended listener for video
        activeVideoTrack.onended = () => {
          setVideoEnabled(false);
          setError('Video device disconnected unexpectedly');
        };
      }

      return stream;
    } catch (err) {
      // Bug fix #14: Differentiate getUserMedia errors with specific messages
      let message: string;
      if (err instanceof DOMException) {
        switch (err.name) {
          case 'NotAllowedError':
            message = 'Camera/microphone permission denied. Please allow access in your browser settings.';
            break;
          case 'NotFoundError':
            message = 'No camera or microphone found. Please connect a media device and try again.';
            break;
          case 'NotReadableError':
            message = 'Camera or microphone is already in use by another application.';
            break;
          case 'OverconstrainedError':
            message = 'The selected device does not support the requested media constraints.';
            break;
          default:
            message = `Media device error: ${err.message}`;
            break;
        }
      } else {
        message = err instanceof Error ? err.message : 'Failed to access media devices';
      }
      setError(message);
      setErrorProblem({ ...createMediaAccessProblem(err, 'both'), message });
      setAudioEnabled(false);
      setVideoEnabled(false);
      stopCurrentStream();
      console.error('Media device error:', err);
      return null;
    }
  }, [enumerateDevices, setErrorProblem, stopCurrentStream]);

  /**
   * Add a camera or microphone track that is missing (blocked earlier, busy,
   * unplugged) to the running stream, so a toggle is never silently dead.
   * Resolves true when the track is now live and enabled.
   */
  const acquireMissingTrack = useCallback(async (kind: 'audio' | 'video'): Promise<boolean> => {
    if (!navigator.mediaDevices?.getUserMedia) return false;
    const device = kind === 'audio' ? 'microphone' : 'camera';
    if (!streamRef.current) {
      const previous = lastStartOptionsRef.current;
      const stream = await startMedia(undefined, undefined, {
        ...previous,
        retryDelayMs: undefined,
        audioEnabled: kind === 'audio' ? true : previous.audioEnabled ?? true,
        videoEnabled: kind === 'video' ? true : previous.videoEnabled ?? true,
      });
      return Boolean(stream?.getTracks().some((track) => track.kind === kind && track.readyState === 'live'));
    }
    if (switchingRef.current) return false;
    switchingRef.current = true;
    try {
      const preferredId = localStorage.getItem(kind === 'audio' ? 'preferredAudioDeviceId' : 'preferredVideoDeviceId');
      const constraintsFor = (deviceId?: string | null): MediaStreamConstraints => (kind === 'audio'
        ? { audio: createAudioTrackConstraints(deviceId, audioProcessingOptionsRef.current) }
        : { video: createVideoTrackConstraints(deviceId, videoQualityRef.current) });
      let raw: MediaStream;
      try {
        raw = await navigator.mediaDevices.getUserMedia(constraintsFor(preferredId));
      } catch (err) {
        if (!preferredId || isMediaPermissionBlock(err)) throw err;
        raw = await navigator.mediaDevices.getUserMedia(constraintsFor());
      }
      const stream = streamRef.current;
      if (!stream) {
        raw.getTracks().forEach((track) => track.stop());
        return false;
      }
      // Drop ended tracks of this kind (an unplugged device) before adding the new one.
      for (const track of kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks()) {
        if (track.readyState === 'ended') stream.removeTrack(track);
      }
      if (kind === 'audio') {
        const enhancedAudio = createEnhancedAudioStream(raw, audioProcessingOptionsRef.current);
        const track = enhancedAudio.stream.getAudioTracks()[0];
        const sourceTrack = enhancedAudio.sourceTrack || track;
        if (!track) {
          enhancedAudio.cleanup({ stopSource: true });
          throw new DOMException('The microphone did not return an audio track.', 'NotReadableError');
        }
        enhancedAudioRef.current?.cleanup({ stopSource: true });
        enhancedAudioRef.current = enhancedAudio.enhanced ? enhancedAudio : null;
        track.enabled = true;
        if (sourceTrack !== track) sourceTrack.enabled = true;
        sourceTrack.onended = () => {
          setAudioEnabled(false);
          setError('Audio device disconnected unexpectedly');
        };
        stream.addTrack(track);
        const activeId = sourceTrack.getSettings().deviceId || '';
        if (activeId) {
          setSelectedAudioDeviceId(activeId);
          localStorage.setItem('preferredAudioDeviceId', activeId);
        }
        setAudioEnabled(true);
      } else {
        const track = raw.getVideoTracks()[0];
        if (!track) throw new DOMException('The camera did not return a video track.', 'NotReadableError');
        track.enabled = true;
        track.onended = () => {
          setVideoEnabled(false);
          setError('Video device disconnected unexpectedly');
        };
        stream.addTrack(track);
        const activeId = track.getSettings().deviceId || '';
        if (activeId) {
          setSelectedVideoDeviceId(activeId);
          localStorage.setItem('preferredVideoDeviceId', activeId);
        }
        setVideoEnabled(true);
      }
      publishStreamUpdate();
      // Keep a remaining problem about the other device; clear this one.
      const remaining = errorProblemRef.current;
      const otherMissing = kind === 'audio' ? stream.getVideoTracks().length === 0 : stream.getAudioTracks().length === 0;
      if (remaining && remaining.device === 'both' && otherMissing) {
        const next = withMediaAccessDevice(remaining, kind === 'audio' ? 'camera' : 'microphone');
        setErrorProblem(next);
        setError(next.message);
      } else if (!remaining || remaining.device === device || remaining.device === 'both') {
        setErrorProblem(null);
        setError(null);
      }
      void enumerateDevices();
      return true;
    } catch (err) {
      const problem = createMediaAccessProblem(err, device);
      setErrorProblem(problem);
      setError(problem.message);
      if (kind === 'audio') setAudioEnabled(false);
      else setVideoEnabled(false);
      console.error(`Could not start the ${device}:`, err);
      return false;
    } finally {
      switchingRef.current = false;
    }
  }, [enumerateDevices, publishStreamUpdate, setErrorProblem, startMedia]);

  /** "Try again": request whatever is missing with the choices the page started with. */
  const retryMedia = useCallback(async (): Promise<boolean> => {
    const stream = streamRef.current;
    if (!stream || liveTrackCount(stream) === 0) {
      const previous = lastStartOptionsRef.current;
      const next = await startMedia(undefined, undefined, { ...previous, retryDelayMs: undefined });
      return Boolean(next && liveTrackCount(next) > 0);
    }
    let ok = true;
    if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) ok = (await acquireMissingTrack('audio')) && ok;
    if (!stream.getVideoTracks().some((track) => track.readyState === 'live')) ok = (await acquireMissingTrack('video')) && ok;
    return ok;
  }, [acquireMissingTrack, startMedia]);

  // Switch audio input device
  const switchAudioDevice = useCallback(async (
    deviceId: string,
    options: Partial<AudioProcessingPreferences> = audioProcessingOptionsRef.current
  ) => {
    if (!streamRef.current) return null;
    if (switchingRef.current) return null;
    switchingRef.current = true;
    const nextAudioProcessing = normalizeAudioProcessingPreferences(options);
    audioProcessingOptionsRef.current = nextAudioProcessing;
    setAudioProcessing(nextAudioProcessing);
    writePreferredAudioProcessing(nextAudioProcessing);

    try {
      const newAudioStream = await navigator.mediaDevices.getUserMedia({
        audio: createAudioTrackConstraints(deviceId, nextAudioProcessing),
      });

      const previousEnhancedAudio = enhancedAudioRef.current;
      const enhancedAudio = createEnhancedAudioStream(newAudioStream, nextAudioProcessing);
      const newAudioTrack = enhancedAudio.stream.getAudioTracks()[0];
      const newSourceAudioTrack = enhancedAudio.sourceTrack || newAudioTrack;
      if (!newAudioTrack) {
        enhancedAudio.cleanup({ stopSource: true });
        throw new Error('Selected microphone did not return an audio track.');
      }
      const oldAudioTrack = streamRef.current.getAudioTracks()[0];

      if (oldAudioTrack) {
        // Preserve mute state
        const nextEnabled = oldAudioTrack.enabled;
        newAudioTrack.enabled = nextEnabled;
        if (newSourceAudioTrack && newSourceAudioTrack !== newAudioTrack) {
          newSourceAudioTrack.enabled = nextEnabled;
        }
        streamRef.current.removeTrack(oldAudioTrack);
        oldAudioTrack.stop();
      }
      previousEnhancedAudio?.cleanup({ stopSource: true });
      enhancedAudioRef.current = enhancedAudio.enhanced ? enhancedAudio : null;

      // Bug fix #15: Add track.onended listener for new audio track
      (newSourceAudioTrack || newAudioTrack).onended = () => {
        setAudioEnabled(false);
        setError('Audio device disconnected unexpectedly');
      };

      streamRef.current.addTrack(newAudioTrack);
      publishStreamUpdate();
      const activeDeviceId = (newSourceAudioTrack || newAudioTrack).getSettings().deviceId || deviceId;
      setSelectedAudioDeviceId(activeDeviceId);
      if (activeDeviceId) localStorage.setItem('preferredAudioDeviceId', activeDeviceId);
      setError(null);
      setErrorProblem(null);

      // Return the new track so WebRTC can replace it on peer connections
      return newAudioTrack;
    } catch (err) {
      console.error('Failed to switch audio device:', err);
      setError('Failed to switch microphone. The selected device may be unavailable.');
      return null;
    } finally {
      switchingRef.current = false;
    }
  }, [publishStreamUpdate]);

  const updateAudioProcessing = useCallback(async (preferences: AudioProcessingPreferences) => {
    const nextAudioProcessing = normalizeAudioProcessingPreferences(preferences);
    audioProcessingOptionsRef.current = nextAudioProcessing;
    setAudioProcessing(nextAudioProcessing);
    writePreferredAudioProcessing(nextAudioProcessing);

    const activeAudioTrack = streamRef.current?.getAudioTracks()[0];
    if (!streamRef.current || !activeAudioTrack || switchingRef.current) return null;

    const sourceAudioTrack = enhancedAudioRef.current?.sourceTrack;
    const activeDeviceId = selectedAudioDeviceId
      || sourceAudioTrack?.getSettings().deviceId
      || activeAudioTrack.getSettings().deviceId
      || localStorage.getItem('preferredAudioDeviceId')
      || '';
    return switchAudioDevice(activeDeviceId, nextAudioProcessing);
  }, [selectedAudioDeviceId, switchAudioDevice]);

  // Switch video input device
  const switchVideoDevice = useCallback(async (
    deviceId: string,
    quality: VideoQualityPresetId = videoQualityRef.current
  ) => {
    if (!streamRef.current) return null;
    if (switchingRef.current) return null;
    switchingRef.current = true;
    videoQualityRef.current = quality;
    setVideoQuality(quality);
    writePreferredVideoQuality(quality);

    try {
      const newVideoStream = await navigator.mediaDevices.getUserMedia({
        video: createVideoTrackConstraints(deviceId, quality),
      });

      const newVideoTrack = newVideoStream.getVideoTracks()[0];
      const oldVideoTrack = streamRef.current.getVideoTracks()[0];

      if (oldVideoTrack) {
        newVideoTrack.enabled = oldVideoTrack.enabled;
        streamRef.current.removeTrack(oldVideoTrack);
        oldVideoTrack.stop();
      }

      // Bug fix #15: Add track.onended listener for new video track
      newVideoTrack.onended = () => {
        setVideoEnabled(false);
        setError('Video device disconnected unexpectedly');
      };

      streamRef.current.addTrack(newVideoTrack);
      publishStreamUpdate();
      setSelectedVideoDeviceId(deviceId);
      localStorage.setItem('preferredVideoDeviceId', deviceId);
      setError(null);
      setErrorProblem(null);

      return newVideoTrack;
    } catch (err) {
      console.error('Failed to switch video device:', err);
      setError('Failed to switch camera. The selected device may be unavailable.');
      return null;
    } finally {
      switchingRef.current = false;
    }
  }, [publishStreamUpdate]);

  const updateVideoQuality = useCallback(async (quality: VideoQualityPresetId) => {
    videoQualityRef.current = quality;
    setVideoQuality(quality);
    writePreferredVideoQuality(quality);

    const activeVideoTrack = streamRef.current?.getVideoTracks()[0];
    if (!streamRef.current || !activeVideoTrack || switchingRef.current) return null;

    const activeDeviceId = selectedVideoDeviceId || activeVideoTrack.getSettings().deviceId || localStorage.getItem('preferredVideoDeviceId') || '';
    if (!activeDeviceId) return null;
    return switchVideoDevice(activeDeviceId, quality);
  }, [selectedVideoDeviceId, switchVideoDevice]);

  const stopMedia = useCallback(() => {
    stopCurrentStream();
  }, [stopCurrentStream]);

  const setAudioTrackEnabled = useCallback((enabled: boolean) => {
    const audioTrack = streamRef.current?.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = enabled;
      const sourceTrack = enhancedAudioRef.current?.sourceTrack;
      if (sourceTrack && sourceTrack !== audioTrack) {
        sourceTrack.enabled = enabled;
      }
      setAudioEnabled(audioTrack.enabled);
      return audioTrack.enabled;
    }
    setAudioEnabled(false);
    return false;
  }, []);

  const setVideoTrackEnabled = useCallback((enabled: boolean) => {
    const videoTrack = streamRef.current?.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = enabled;
      setVideoEnabled(videoTrack.enabled);
      return videoTrack.enabled;
    }
    setVideoEnabled(false);
    return false;
  }, []);

  // With no live track of that kind, turning it on asks for the device again
  // (the result arrives through localStream); the toggle is never dead.
  const toggleAudio = useCallback(() => {
    const audioTrack = streamRef.current?.getAudioTracks().find((track) => track.readyState === 'live');
    if (!audioTrack) {
      void acquireMissingTrack('audio');
      return false;
    }
    return setAudioTrackEnabled(!audioTrack.enabled);
  }, [acquireMissingTrack, setAudioTrackEnabled]);

  const toggleVideo = useCallback(() => {
    const videoTrack = streamRef.current?.getVideoTracks().find((track) => track.readyState === 'live');
    if (!videoTrack) {
      void acquireMissingTrack('video');
      return false;
    }
    return setVideoTrackEnabled(!videoTrack.enabled);
  }, [acquireMissingTrack, setVideoTrackEnabled]);

  // Listen for device changes (plugging in / removing devices)
  useEffect(() => {
    const handleDeviceChange = async () => {
      await enumerateDevices();

      // Bug fix #16: Handle device disconnection - check if current tracks have ended
      if (streamRef.current) {
        const publishedAudioTrack = streamRef.current.getAudioTracks()[0];
        const audioTrack = enhancedAudioRef.current?.sourceTrack || publishedAudioTrack;
        const videoTrack = streamRef.current.getVideoTracks()[0];

        // If the audio track has ended, attempt to switch to a fallback device
        if (audioTrack && audioTrack.readyState === 'ended') {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const fallbackAudio = devices.find(
            (d) => d.kind === 'audioinput' && d.deviceId !== audioTrack.getSettings().deviceId
          );
          if (fallbackAudio) {
            console.info('Audio device disconnected, switching to fallback:', fallbackAudio.label);
            const audioProcessing = audioProcessingOptionsRef.current;
            try {
              const newStream = await navigator.mediaDevices.getUserMedia({
                audio: createAudioTrackConstraints(fallbackAudio.deviceId, audioProcessing),
              });
              const previousEnhancedAudio = enhancedAudioRef.current;
              const enhancedAudio = createEnhancedAudioStream(newStream, audioProcessing);
              const newTrack = enhancedAudio.stream.getAudioTracks()[0];
              const newSourceTrack = enhancedAudio.sourceTrack || newTrack;
              if (!newTrack) {
                enhancedAudio.cleanup({ stopSource: true });
                throw new Error('Fallback microphone did not return an audio track.');
              }
              previousEnhancedAudio?.cleanup({ stopSource: true });
              enhancedAudioRef.current = enhancedAudio.enhanced ? enhancedAudio : null;
              const nextEnabled = replaceFallbackMediaTrack(streamRef.current, publishedAudioTrack, newTrack, newSourceTrack);
              publishStreamUpdate();
              setSelectedAudioDeviceId(fallbackAudio.deviceId);
              setAudioEnabled(nextEnabled);

              (newSourceTrack || newTrack).onended = () => {
                setAudioEnabled(false);
                setError('Audio device disconnected unexpectedly');
              };
            } catch (err) {
              console.error('Failed to switch to fallback audio device:', err);
              setError('Audio device disconnected and no fallback available');
            }
          } else {
            setError('Audio device disconnected and no fallback available');
          }
        }

        // If the video track has ended, attempt to switch to a fallback device
        if (videoTrack && videoTrack.readyState === 'ended') {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const fallbackVideo = devices.find(
            (d) => d.kind === 'videoinput' && d.deviceId !== videoTrack.getSettings().deviceId
          );
          if (fallbackVideo) {
            console.info('Video device disconnected, switching to fallback:', fallbackVideo.label);
            try {
              const newStream = await navigator.mediaDevices.getUserMedia({
                video: createVideoTrackConstraints(fallbackVideo.deviceId, videoQualityRef.current),
              });
              const newTrack = newStream.getVideoTracks()[0];
              const nextEnabled = replaceFallbackMediaTrack(streamRef.current, videoTrack, newTrack);
              publishStreamUpdate();
              setSelectedVideoDeviceId(fallbackVideo.deviceId);
              setVideoEnabled(nextEnabled);

              newTrack.onended = () => {
                setVideoEnabled(false);
                setError('Video device disconnected unexpectedly');
              };
            } catch (err) {
              console.error('Failed to switch to fallback video device:', err);
              setError('Video device disconnected and no fallback available');
            }
          } else {
            setError('Video device disconnected and no fallback available');
          }
        }
      }
    };
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, [enumerateDevices, publishStreamUpdate]);

  // Apply audio output device (setSinkId) to a given media element
  const applyAudioOutput = useCallback(async (element: HTMLMediaElement) => {
    const el = element as SinkIdElement;
    if (typeof el.setSinkId === 'function' && audioOutputIdRef.current) {
      try {
        await el.setSinkId(audioOutputIdRef.current);
      } catch (err) {
        console.error('Failed to set audio output device:', err);
        setError('Failed to switch speaker output. The selected device may be unavailable.');
      }
    }
  }, []);

  // Change the selected audio output device and try to apply immediately
  const onAudioOutputDeviceChange = useCallback(async (deviceId: string) => {
    setSelectedAudioOutputDeviceId(deviceId);
    audioOutputIdRef.current = deviceId;

    // Attempt to apply to all existing <audio> and <video> elements in the document
    const mediaElements = document.querySelectorAll<HTMLMediaElement>('audio, video');
    for (const el of mediaElements) {
      const sinkEl = el as SinkIdElement;
      if (typeof sinkEl.setSinkId === 'function') {
        try {
          await sinkEl.setSinkId(deviceId);
        } catch (err) {
          console.error('Failed to set audio output on element:', err);
          setError('Failed to switch speaker output. The selected device may be unavailable.');
        }
      }
    }
    
    // Persist this choice
    localStorage.setItem('preferredAudioOutputDeviceId', deviceId);
  }, []);

  useEffect(() => {
    return () => {
      stopMedia();
    };
  }, [stopMedia]);

  return {
    localStream,
    audioEnabled,
    videoEnabled,
    error,
    errorProblem,
    // Device lists
    audioDevices,
    videoDevices,
    audioOutputDevices,
    audioProcessing,
    videoQuality,
    recommendedVideoQuality,
    // Selected devices
    selectedAudioDeviceId,
    selectedVideoDeviceId,
    selectedAudioOutputDeviceId,
    setSelectedAudioOutputDeviceId,
    // Actions
    startMedia,
    stopMedia,
    setAudioTrackEnabled,
    setVideoTrackEnabled,
    toggleAudio,
    toggleVideo,
    acquireMissingTrack,
    retryMedia,
    switchAudioDevice,
    switchVideoDevice,
    updateAudioProcessing,
    updateVideoQuality,
    enumerateDevices,
    applyAudioOutput,
    onAudioOutputDeviceChange,
  };
}
