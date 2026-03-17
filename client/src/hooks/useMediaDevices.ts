import { useState, useCallback, useRef, useEffect } from 'react';

export interface MediaDeviceInfo {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'videoinput' | 'audiooutput';
}

export function useMediaDevices() {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([]);

  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState<string>('');
  const [selectedVideoDeviceId, setSelectedVideoDeviceId] = useState<string>('');
  const [selectedAudioOutputDeviceId, setSelectedAudioOutputDeviceId] = useState<string>('');

  const streamRef = useRef<MediaStream | null>(null);

  // Enumerate all available media devices
  const enumerateDevices = useCallback(async () => {
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
  const startMedia = useCallback(async (audioDeviceId?: string, videoDeviceId?: string) => {
    try {
      // Stop any existing tracks first
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }

      const constraints: MediaStreamConstraints = {
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
          ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {}),
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {}),
        },
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      setLocalStream(stream);
      setError(null);

      // After getting the stream, enumerate devices to get labels
      // (labels are only available after granting permission)
      const { audio, video } = await enumerateDevices();

      // Track which devices are actually active
      const activeAudioTrack = stream.getAudioTracks()[0];
      const activeVideoTrack = stream.getVideoTracks()[0];

      if (activeAudioTrack) {
        const settings = activeAudioTrack.getSettings();
        const activeId = settings.deviceId || '';
        setSelectedAudioDeviceId(activeId);

        // Bug fix #15: Add track.onended listener for audio
        activeAudioTrack.onended = () => {
          setAudioEnabled(false);
          setError('Audio device disconnected unexpectedly');
        };
      }
      if (activeVideoTrack) {
        const settings = activeVideoTrack.getSettings();
        const activeId = settings.deviceId || '';
        setSelectedVideoDeviceId(activeId);

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
      console.error('Media device error:', err);
      return null;
    }
  }, [enumerateDevices]);

  // Switch audio input device
  const switchAudioDevice = useCallback(async (deviceId: string) => {
    if (!streamRef.current) return;

    try {
      const newAudioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const newAudioTrack = newAudioStream.getAudioTracks()[0];
      const oldAudioTrack = streamRef.current.getAudioTracks()[0];

      if (oldAudioTrack) {
        // Preserve mute state
        newAudioTrack.enabled = oldAudioTrack.enabled;
        streamRef.current.removeTrack(oldAudioTrack);
        oldAudioTrack.stop();
      }

      // Bug fix #15: Add track.onended listener for new audio track
      newAudioTrack.onended = () => {
        setAudioEnabled(false);
        setError('Audio device disconnected unexpectedly');
      };

      streamRef.current.addTrack(newAudioTrack);
      setSelectedAudioDeviceId(deviceId);

      // Return the new track so WebRTC can replace it on peer connections
      return newAudioTrack;
    } catch (err) {
      console.error('Failed to switch audio device:', err);
      return null;
    }
  }, []);

  // Switch video input device
  const switchVideoDevice = useCallback(async (deviceId: string) => {
    if (!streamRef.current) return;

    try {
      const newVideoStream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
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
      setSelectedVideoDeviceId(deviceId);

      return newVideoTrack;
    } catch (err) {
      console.error('Failed to switch video device:', err);
      return null;
    }
  }, []);

  const stopMedia = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setLocalStream(null);
    }
  }, []);

  const toggleAudio = useCallback(() => {
    if (streamRef.current) {
      const audioTrack = streamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setAudioEnabled(audioTrack.enabled);
        return audioTrack.enabled;
      }
    }
    return audioEnabled;
  }, [audioEnabled]);

  const toggleVideo = useCallback(() => {
    if (streamRef.current) {
      const videoTrack = streamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setVideoEnabled(videoTrack.enabled);
        return videoTrack.enabled;
      }
    }
    return videoEnabled;
  }, [videoEnabled]);

  // Listen for device changes (plugging in / removing devices)
  useEffect(() => {
    const handleDeviceChange = async () => {
      await enumerateDevices();

      // Bug fix #16: Handle device disconnection - check if current tracks have ended
      if (streamRef.current) {
        const audioTrack = streamRef.current.getAudioTracks()[0];
        const videoTrack = streamRef.current.getVideoTracks()[0];

        // If the audio track has ended, attempt to switch to a fallback device
        if (audioTrack && audioTrack.readyState === 'ended') {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const fallbackAudio = devices.find(
            (d) => d.kind === 'audioinput' && d.deviceId !== audioTrack.getSettings().deviceId
          );
          if (fallbackAudio) {
            console.log('Audio device disconnected, switching to fallback:', fallbackAudio.label);
            try {
              const newStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                  deviceId: { exact: fallbackAudio.deviceId },
                  echoCancellation: true,
                  noiseSuppression: true,
                  autoGainControl: true,
                },
              });
              const newTrack = newStream.getAudioTracks()[0];
              streamRef.current.removeTrack(audioTrack);
              streamRef.current.addTrack(newTrack);
              setSelectedAudioDeviceId(fallbackAudio.deviceId);
              setAudioEnabled(true);

              newTrack.onended = () => {
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
                video: {
                  deviceId: { exact: fallbackVideo.deviceId },
                  width: { ideal: 1920 },
                  height: { ideal: 1080 },
                  frameRate: { ideal: 30 },
                },
              });
              const newTrack = newStream.getVideoTracks()[0];
              streamRef.current.removeTrack(videoTrack);
              streamRef.current.addTrack(newTrack);
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
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, [enumerateDevices]);

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
    // Selected devices
    selectedAudioDeviceId,
    selectedVideoDeviceId,
    selectedAudioOutputDeviceId,
    setSelectedAudioOutputDeviceId,
    // Actions
    startMedia,
    stopMedia,
    toggleAudio,
    toggleVideo,
    switchAudioDevice,
    switchVideoDevice,
    enumerateDevices,
  };
}
