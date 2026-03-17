import { useState, useRef, useCallback, useEffect } from 'react';

export interface RecordingResult {
  audio: Blob;
  video: Blob;
  screen?: Blob;
}

interface TrackRecorder {
  recorder: MediaRecorder;
  chunks: Blob[];
}

export function useLocalRecording() {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);

  const audioRecorderRef = useRef<TrackRecorder | null>(null);
  const videoRecorderRef = useRef<TrackRecorder | null>(null);
  const screenRecorderRef = useRef<TrackRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);

  // Guard against double-stop
  const stoppingRef = useRef<boolean>(false);

  const getAudioMimeType = (): string => {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ];
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  };

  const getVideoMimeType = (): string => {
    const types = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  };

  const getScreenMimeType = (): string => {
    const types = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  };

  const createTrackRecorder = (
    stream: MediaStream,
    mimeType: string,
    bitsPerSecond: number,
    label: string
  ): TrackRecorder | null => {
    if (!mimeType) {
      console.error(`No supported MIME type for ${label} recording`);
      return null;
    }

    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, {
      mimeType,
      bitsPerSecond,
    });

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunks.push(e.data);
      }
    };

    recorder.onerror = (e) => {
      console.error(`Recording error for ${label}:`, e);
    };

    return { recorder, chunks };
  };

  const startRecording = useCallback(
    (localStream: MediaStream, screenStream?: MediaStream | null) => {
      // Guard against double-start
      if (isRecording) return;

      // 1. Audio-only recorder: extract audio track from localStream
      const audioTracks = localStream.getAudioTracks();
      if (audioTracks.length === 0) {
        console.warn('No audio track found in localStream');
      }

      const audioStream = new MediaStream(audioTracks);
      const audioMime = getAudioMimeType();
      const audioTrackRecorder = createTrackRecorder(
        audioStream,
        audioMime,
        256_000, // 256 kbps
        'audio'
      );
      audioRecorderRef.current = audioTrackRecorder;

      // 2. Video-only recorder: extract video track from localStream
      const videoTracks = localStream.getVideoTracks();
      if (videoTracks.length === 0) {
        console.warn('No video track found in localStream');
      }

      const videoStream = new MediaStream(videoTracks);
      const videoMime = getVideoMimeType();
      const videoTrackRecorder = createTrackRecorder(
        videoStream,
        videoMime,
        8_000_000, // 8 Mbps
        'video'
      );
      videoRecorderRef.current = videoTrackRecorder;

      // 3. Screen share recorder (conditional)
      if (screenStream) {
        const screenMime = getScreenMimeType();
        const screenTrackRecorder = createTrackRecorder(
          screenStream,
          screenMime,
          8_000_000, // 8 Mbps
          'screen'
        );
        screenRecorderRef.current = screenTrackRecorder;
      } else {
        screenRecorderRef.current = null;
      }

      // Start all recorders with 1-second chunks
      let startedCount = 0;
      if (audioRecorderRef.current) {
        audioRecorderRef.current.recorder.start(1000);
        startedCount++;
      }
      if (videoRecorderRef.current) {
        videoRecorderRef.current.recorder.start(1000);
        startedCount++;
      }
      if (screenRecorderRef.current) {
        screenRecorderRef.current.recorder.start(1000);
        startedCount++;
      }

      // Start timer
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setRecordingDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);

      setIsRecording(true);
      console.log(`Local recording started: ${startedCount} track(s)`);
    },
    [isRecording]
  );

  const stopSingleRecorder = (
    trackRecorder: TrackRecorder | null,
    label: string
  ): Promise<Blob | null> => {
    return new Promise((resolve) => {
      if (!trackRecorder) {
        resolve(null);
        return;
      }

      const { recorder, chunks } = trackRecorder;

      if (recorder.state === 'inactive') {
        // Recorder already inactive - collect existing chunks directly
        const blob = new Blob(chunks, { type: recorder.mimeType });
        resolve(blob);
        return;
      }

      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType });
        console.log(`${label} recording stopped: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
        resolve(blob);
      };

      recorder.stop();
    });
  };

  const stopRecording = useCallback((): Promise<RecordingResult> => {
    // Guard against double-stop
    if (stoppingRef.current) {
      return Promise.resolve({
        audio: new Blob(),
        video: new Blob(),
      });
    }
    stoppingRef.current = true;

    // Stop timer
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    const audioPromise = stopSingleRecorder(audioRecorderRef.current, 'audio');
    const videoPromise = stopSingleRecorder(videoRecorderRef.current, 'video');
    const screenPromise = stopSingleRecorder(screenRecorderRef.current, 'screen');

    return Promise.all([audioPromise, videoPromise, screenPromise]).then(
      ([audioBlob, videoBlob, screenBlob]) => {
        // Clean up refs
        audioRecorderRef.current = null;
        videoRecorderRef.current = null;
        screenRecorderRef.current = null;

        setIsRecording(false);
        setRecordingDuration(0);
        stoppingRef.current = false;

        const result: RecordingResult = {
          audio: audioBlob || new Blob(),
          video: videoBlob || new Blob(),
        };

        if (screenBlob && screenBlob.size > 0) {
          result.screen = screenBlob;
        }

        console.log('Local recording stopped. Tracks:', {
          audio: `${((result.audio.size) / 1024 / 1024).toFixed(2)} MB`,
          video: `${((result.video.size) / 1024 / 1024).toFixed(2)} MB`,
          screen: result.screen ? `${((result.screen.size) / 1024 / 1024).toFixed(2)} MB` : 'none',
        });

        return result;
      }
    );
  }, []);

  const formatTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Cleanup on unmount - clear interval, stop recorders
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      const recorders = [
        audioRecorderRef.current,
        videoRecorderRef.current,
        screenRecorderRef.current,
      ];
      for (const trackRecorder of recorders) {
        if (trackRecorder && trackRecorder.recorder.state !== 'inactive') {
          try {
            trackRecorder.recorder.stop();
          } catch {
            // Recorder may already be in an invalid state
          }
        }
      }
      audioRecorderRef.current = null;
      videoRecorderRef.current = null;
      screenRecorderRef.current = null;
    };
  }, []);

  return {
    isRecording,
    recordingDuration,
    formattedTime: formatTime(recordingDuration),
    startRecording,
    stopRecording,
  };
}
