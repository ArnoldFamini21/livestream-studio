import { useState, useRef, useCallback, useEffect } from 'react';

export interface RecordingResult {
  audio: Blob;
  video: Blob;
  screen?: Blob;
  program?: Blob;
  files: LocalRecordingFileResult[];
}

export interface LocalRecordingFileResult {
  label: string;
  blob: Blob;
  kind: LocalRecordingSource['kind'];
}

export interface LocalRecordingSource {
  id: string;
  label: string;
  stream: MediaStream;
  kind: 'audio' | 'video' | 'screen' | 'program' | 'iso';
  bitsPerSecond?: number;
  cleanup?: () => void;
}

interface TrackRecorder {
  id: string;
  label: string;
  kind: LocalRecordingSource['kind'];
  recorder: MediaRecorder;
  chunks: Blob[];
  activeWritable?: any; // FileSystemWritableFileStream
  fileHandle?: any; // FileSystemFileHandle
  getWritePromise: () => Promise<void> | null;
  cleanup?: () => void;
}

export function useLocalRecording() {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [recordingLabels, setRecordingLabels] = useState<string[]>([]);

  const recordersRef = useRef<TrackRecorder[]>([]);
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

  const getMimeTypeForSource = (source: LocalRecordingSource): string => {
    if (source.kind === 'audio') return getAudioMimeType();
    if (source.kind === 'screen' || source.kind === 'program' || source.kind === 'iso') return getScreenMimeType();
    const hasVideo = source.stream.getVideoTracks().some((track) => track.readyState === 'live');
    return hasVideo ? getVideoMimeType() : getAudioMimeType();
  };

  const getBitsPerSecondForSource = (source: LocalRecordingSource): number => {
    if (source.bitsPerSecond) return source.bitsPerSecond;
    if (source.kind === 'audio') return 256_000;
    if (source.kind === 'program') return 10_000_000;
    if (source.kind === 'iso') return 8_500_000;
    if (source.kind === 'screen') return 8_000_000;
    const hasVideo = source.stream.getVideoTracks().some((track) => track.readyState === 'live');
    return hasVideo ? 8_000_000 : 256_000;
  };

  const createTrackRecorder = async (source: LocalRecordingSource, dirHandle?: any): Promise<TrackRecorder | null> => {
    const stream = new MediaStream(source.stream.getTracks().filter((track) => track.readyState === 'live'));
    if (stream.getTracks().length === 0) return null;
    const mimeType = getMimeTypeForSource({ ...source, stream });
    const bitsPerSecond = getBitsPerSecondForSource({ ...source, stream });
    if (!mimeType) {
      console.error(`No supported MIME type for ${source.label} recording`);
      return null;
    }

    const chunks: Blob[] = [];
    let fileHandle: any = undefined;
    let activeWritable: any = undefined;

    if (dirHandle) {
      try {
        const ext = mimeType.includes('ogg') ? 'ogg' : 'webm';
        fileHandle = await dirHandle.getFileHandle(`${source.id}-${Date.now()}.${ext}`, { create: true });
        activeWritable = await fileHandle.createWritable();
      } catch (err) {
        console.warn(`Failed to create OPFS file for ${source.label}, falling back to memory chunks`, err);
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
              console.error(`OPFS write error for ${source.label}:`, err);
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
      console.error(`Recording error for ${source.label}:`, e);
    };

    return {
      id: source.id,
      label: source.label,
      kind: source.kind,
      recorder,
      chunks,
      fileHandle,
      activeWritable,
      getWritePromise: () => currentWritePromise,
      cleanup: source.cleanup,
    };
  };

  const getDefaultSources = (localStream: MediaStream, screenStream?: MediaStream | null): LocalRecordingSource[] => {
    const sources: LocalRecordingSource[] = [];
    const audioTracks = localStream.getAudioTracks().filter((track) => track.readyState === 'live');
    const videoTracks = localStream.getVideoTracks().filter((track) => track.readyState === 'live');

    if (audioTracks.length > 0) {
      sources.push({
        id: 'local-audio',
        label: 'Audio',
        kind: 'audio',
        stream: new MediaStream(audioTracks),
        bitsPerSecond: 256_000,
      });
    }

    if (videoTracks.length > 0) {
      sources.push({
        id: 'local-video',
        label: 'Video',
        kind: 'video',
        stream: new MediaStream(videoTracks),
        bitsPerSecond: 8_000_000,
      });
    }

    if (screenStream && screenStream.getTracks().some((track) => track.readyState === 'live')) {
      sources.push({
        id: 'screen',
        label: 'Screen',
        kind: 'screen',
        stream: screenStream,
        bitsPerSecond: 8_000_000,
      });
    }

    return sources;
  };

  const startRecording = useCallback(
    async (input: MediaStream | LocalRecordingSource[], screenStream?: MediaStream | null) => {
      // Guard against double-start
      if (isRecording) return;
      const sources = (Array.isArray(input) ? input : getDefaultSources(input, screenStream))
        .map((source) => ({
          ...source,
          stream: new MediaStream(source.stream.getTracks().filter((track) => track.readyState === 'live')),
        }))
        .filter((source) => source.stream.getTracks().length > 0);
      if (sources.length === 0) return;

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

      const recorders: TrackRecorder[] = [];
      for (const source of sources) {
        const trackRecorder = await createTrackRecorder(source, dirHandle);
        if (trackRecorder) {
          recorders.push(trackRecorder);
        } else {
          source.cleanup?.();
        }
      }
      if (recorders.length === 0) return;

      // Start all recorders with 1-second chunks
      try {
        for (const trackRecorder of recorders) {
          trackRecorder.recorder.start(1000);
        }
      } catch (err) {
        for (const trackRecorder of recorders) {
          try {
            if (trackRecorder.recorder.state !== 'inactive') trackRecorder.recorder.stop();
          } catch {
            // ignore failed cleanup after a start failure
          }
          trackRecorder.cleanup?.();
        }
        throw err;
      }
      recordersRef.current = recorders;
      setRecordingLabels(recorders.map((recorder) => recorder.label));

      // Start timer
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setRecordingDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);

      setIsRecording(true);
      console.log(`Local recording started on disk/RAM: ${recorders.length} track(s)`);
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

      const { recorder, chunks, activeWritable, fileHandle, getWritePromise, cleanup } = trackRecorder;
      let cleanedUp = false;
      const cleanupSource = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        cleanup?.();
      };

      const finishUp = async () => {
        if (activeWritable) {
          try {
            const p = getWritePromise();
            if (p) await p; // wait for final chunk write
            await activeWritable.close();
            const file = await fileHandle.getFile();
            console.log(`${label} OPFS recording stopped. Size: ${(file.size / 1024 / 1024).toFixed(2)} MB`);
            cleanupSource();
            resolve(file); // returning File object maps to disk, doesn't load into RAM
            return;
          } catch (err) {
            console.error(`Error closing OPFS file for ${label}:`, err);
            // Fallthrough to memory chunks if OPFS threw error
          }
        }
        
        const blob = new Blob(chunks, { type: recorder.mimeType });
        console.log(`${label} RAM recording stopped. Size: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
        cleanupSource();
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
      return Promise.resolve({ audio: new Blob(), video: new Blob(), files: [] });
    }
    stoppingRef.current = true;

    // Stop timer
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    const activeRecorders = [...recordersRef.current];
    const stopPromises = activeRecorders.map((trackRecorder) => stopSingleRecorder(trackRecorder, trackRecorder.label));

    return Promise.all(stopPromises).then(
      (blobs) => {
        // Clean up refs
        recordersRef.current = [];

        setIsRecording(false);
        setRecordingDuration(0);
        setRecordingLabels([]);
        stoppingRef.current = false;

        const files = activeRecorders.flatMap((recorder, index): LocalRecordingFileResult[] => {
          const blob = blobs[index];
          return blob && blob.size > 0 ? [{ label: recorder.label, kind: recorder.kind, blob }] : [];
        });
        const audioBlob = files.find((file) => file.kind === 'audio')?.blob || new Blob();
        const videoBlob = files.find((file) => file.kind === 'video')?.blob || new Blob();
        const screenBlob = files.find((file) => file.kind === 'screen')?.blob;
        const programBlob = files.find((file) => file.kind === 'program')?.blob;
        const result: RecordingResult = {
          audio: audioBlob,
          video: videoBlob,
          files,
        };

        if (screenBlob && screenBlob.size > 0) {
          result.screen = screenBlob;
        }
        if (programBlob && programBlob.size > 0) {
          result.program = programBlob;
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
      for (const trackRecorder of recordersRef.current) {
        if (trackRecorder && trackRecorder.recorder.state !== 'inactive') {
          try {
            trackRecorder.recorder.stop();
            if (trackRecorder.activeWritable) {
              // Fire-and-forget close during quick unmount
              trackRecorder.activeWritable.close().catch(() => {});
            }
            trackRecorder.cleanup?.();
          } catch {
            // ignore
          }
        }
      }
      recordersRef.current = [];
    };
  }, []);

  return {
    isRecording,
    formattedTime: formatTime(recordingDuration),
    recordingLabels,
    startRecording,
    stopRecording,
  };
}
