import { useState, useCallback, useRef, useEffect } from 'react';
import {
  createAudioTrackConstraints,
  normalizeAudioProcessingPreferences,
} from '../utils/audioProcessing.ts';
import {
  createEnhancedAudioStream,
  type EnhancedAudioStream,
} from '../utils/audioEnhancement.ts';
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

interface StartMediaOptions extends Partial<AudioProcessingPreferences> {
  audioEnabled?: boolean;
  videoEnabled?: boolean;
  videoQuality?: VideoQualityPresetId;
}

export function useMediaDevices() {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      return null;
    }

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
            return { stream, usedFallback: index > 0 };
          } catch (err) {
            lastError = err;
          }
        }
        throw lastError;
      };

      let stream: MediaStream;
      try {
        const result = await tryMediaAttempts(avAttempts);
        stream = result.stream;
        setError(result.usedFallback ? 'Preferred device unavailable - using available camera and microphone' : null);
      } catch {
        // Audio+video failed -- try audio only
        try {
          const result = await tryMediaAttempts(audioOnlyAttempts);
          stream = result.stream;
          setError('Camera not available - audio only');
        } catch {
          // Audio only failed -- try video only
          try {
            const result = await tryMediaAttempts(videoOnlyAttempts);
            stream = result.stream;
            setError('Microphone not available - video only');
          } catch (finalErr) {
            setError('No media devices available');
            setAudioEnabled(false);
            setVideoEnabled(false);
            stopCurrentStream();
            return null;
          }
        }
      }
      const enhancedAudio = createEnhancedAudioStream(stream, nextAudioProcessing);
      stream = enhancedAudio.stream;
      enhancedAudioRef.current = enhancedAudio.enhanced ? enhancedAudio : null;
      streamRef.current = stream;
      setLocalStream(stream);

      // After getting the stream, enumerate devices to get labels
      // (labels are only available after granting permission)
      await enumerateDevices();

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
      setAudioEnabled(false);
      setVideoEnabled(false);
      stopCurrentStream();
      console.error('Media device error:', err);
      return null;
    }
  }, [enumerateDevices, stopCurrentStream]);

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

  const toggleAudio = useCallback(() => {
    const audioTrack = streamRef.current?.getAudioTracks()[0];
    return setAudioTrackEnabled(!audioTrack?.enabled);
  }, [setAudioTrackEnabled]);

  const toggleVideo = useCallback(() => {
    const videoTrack = streamRef.current?.getVideoTracks()[0];
    return setVideoTrackEnabled(!videoTrack?.enabled);
  }, [setVideoTrackEnabled]);

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
            console.log('Audio device disconnected, switching to fallback:', fallbackAudio.label);
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
              const nextEnabled = publishedAudioTrack?.enabled ?? true;
              newTrack.enabled = nextEnabled;
              if (newSourceTrack && newSourceTrack !== newTrack) {
                newSourceTrack.enabled = nextEnabled;
              }
              if (publishedAudioTrack) {
                streamRef.current.removeTrack(publishedAudioTrack);
                publishedAudioTrack.stop();
              }
              previousEnhancedAudio?.cleanup({ stopSource: true });
              enhancedAudioRef.current = enhancedAudio.enhanced ? enhancedAudio : null;
              streamRef.current.addTrack(newTrack);
              publishStreamUpdate();
              setSelectedAudioDeviceId(fallbackAudio.deviceId);
              setAudioEnabled(true);

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
            console.log('Video device disconnected, switching to fallback:', fallbackVideo.label);
            try {
              const newStream = await navigator.mediaDevices.getUserMedia({
                video: createVideoTrackConstraints(fallbackVideo.deviceId, videoQualityRef.current),
              });
              const newTrack = newStream.getVideoTracks()[0];
              streamRef.current.removeTrack(videoTrack);
              streamRef.current.addTrack(newTrack);
              publishStreamUpdate();
              setSelectedVideoDeviceId(fallbackVideo.deviceId);
              setVideoEnabled(true);

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
    switchAudioDevice,
    switchVideoDevice,
    updateAudioProcessing,
    updateVideoQuality,
    enumerateDevices,
    applyAudioOutput,
    onAudioOutputDeviceChange,
  };
}
