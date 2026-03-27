import { useState, useRef, useCallback, useEffect } from 'react';

export interface RecordingResult {
  audio: Blob;
  video: Blob;
  screen?: Blob;
}

interface TrackRecorder {
  recorder: MediaRecorder;
  chunks: Blob[];
  activeWritable?: any; // FileSystemWritableFileStream
  fileHandle?: any; // FileSystemFileHandle
  getWritePromise: () => Promise<void> | null;
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

  const createTrackRecorder = async (
    stream: MediaStream,
    mimeType: string,
    bitsPerSecond: number,
    label: string,
    dirHandle?: any
  ): Promise<TrackRecorder | null> => {
    if (!mimeType) {
      console.error(`No supported MIME type for ${label} recording`);
      return null;
    }

    const chunks: Blob[] = [];
    let fileHandle: any = undefined;
    let activeWritable: any = undefined;

    if (dirHandle) {
      try {
        const ext = mimeType.includes('ogg') ? 'ogg' : 'webm';
        fileHandle = await dirHandle.getFileHandle(`${label}-${Date.now()}.${ext}`, { create: true });
        activeWritable = await fileHandle.createWritable();
      } catch (err) {
        console.warn(`Failed to create OPFS file for ${label}, falling back to memory chunks`, err);
      }
    }

    const recorder = new MediaRecorder(stream, {
      mimeType,
      bitsPerSecond,
    });

    let currentWritePromise: Promise<void> | null = null;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        if (activeWritable) {
          const p = (async () => {
            if (currentWritePromise) await currentWritePromise;
            try {
              await activeWritable.write(e.data);
            } catch (err) {
              console.error(`OPFS write error for ${label}:`, err);
              chunks.push(e.data); // Fallback to memory
            }
          })();
          currentWritePromise = p;
        } else {
          chunks.push(e.data);
        }
      }
    };

    recorder.onerror = (e) => {
      console.error(`Recording error for ${label}:`, e);
    };

    return { recorder, chunks, fileHandle, activeWritable, getWritePromise: () => currentWritePromise };
  };

  const startRecording = useCallback(
    async (localStream: MediaStream, screenStream?: MediaStream | null) => {
      // Guard against double-start
      if (isRecording) return;

      let dirHandle: any = undefined;
      try {
        if (navigator.storage && navigator.storage.getDirectory) {
          const opfsRoot = await navigator.storage.getDirectory();
          dirHandle = await opfsRoot.getDirectoryHandle(`recording-${Date.now()}`, { create: true });
          console.log('OPFS Directory created for local recording');
        }
      } catch (err) {
        console.warn('OPFS not available, chunks will be stored in RAM', err);
      }

      // 1. Audio-only recorder
      const audioTracks = localStream.getAudioTracks();
      if (audioTracks.length === 0) console.warn('No audio track found in localStream');
      const audioStream = new MediaStream(audioTracks);
      const audioMime = getAudioMimeType();
      audioRecorderRef.current = await createTrackRecorder(audioStream, audioMime, 256_000, 'audio', dirHandle);

      // 2. Video-only recorder
      const videoTracks = localStream.getVideoTracks();
      if (videoTracks.length === 0) console.warn('No video track found in localStream');
      const videoStream = new MediaStream(videoTracks);
      const videoMime = getVideoMimeType();
      videoRecorderRef.current = await createTrackRecorder(videoStream, videoMime, 8_000_000, 'video', dirHandle);

      // 3. Screen share recorder (conditional)
      if (screenStream) {
        const screenMime = getScreenMimeType();
        screenRecorderRef.current = await createTrackRecorder(screenStream, screenMime, 8_000_000, 'screen', dirHandle);
      } else {
        screenRecorderRef.current = null;
      }

      // Start all recorders with 1-second chunks
      let startedCount = 0;
      if (audioRecorderRef.current) { audioRecorderRef.current.recorder.start(1000); startedCount++; }
      if (videoRecorderRef.current) { videoRecorderRef.current.recorder.start(1000); startedCount++; }
      if (screenRecorderRef.current) { screenRecorderRef.current.recorder.start(1000); startedCount++; }

      // Start timer
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setRecordingDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);

      setIsRecording(true);
      console.log(`Local recording started on disk/RAM: ${startedCount} track(s)`);
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

      const { recorder, chunks, activeWritable, fileHandle, getWritePromise } = trackRecorder;

      const finishUp = async () => {
        if (activeWritable) {
          try {
            const p = getWritePromise();
            if (p) await p; // wait for final chunk write
            await activeWritable.close();
            const file = await fileHandle.getFile();
            console.log(`${label} OPFS recording stopped. Size: ${(file.size / 1024 / 1024).toFixed(2)} MB`);
            resolve(file); // returning File object maps to disk, doesn't load into RAM
            return;
          } catch (err) {
            console.error(`Error closing OPFS file for ${label}:`, err);
            // Fallthrough to memory chunks if OPFS threw error
          }
        }
        
        const blob = new Blob(chunks, { type: recorder.mimeType });
        console.log(`${label} RAM recording stopped. Size: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
        resolve(blob);
      };

      if (recorder.state === 'inactive') {
        finishUp();
        return;
      }

      recorder.onstop = () => {
        finishUp();
      };

      recorder.stop();
    });
  };

  const stopRecording = useCallback((): Promise<RecordingResult> => {
    // Guard against double-stop
    if (stoppingRef.current) {
      return Promise.resolve({ audio: new Blob(), video: new Blob() });
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

        console.log('Local recording stopped completely.');
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

  // Cleanup on unmount
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
            if (trackRecorder.activeWritable) {
              // Fire-and-forget close during quick unmount
              trackRecorder.activeWritable.close().catch(() => {});
            }
          } catch {
            // ignore
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
    formattedTime: formatTime(recordingDuration),
    startRecording,
    stopRecording,
  };
}
