import { useState, useRef, useCallback, useEffect } from 'react';
import {
  createRecordingCaptureMetadata,
  finalizeRecordingCaptureMetadata,
  type RecordingCaptureEncoderMetadata,
  type RecordingCaptureMetadata,
} from '../utils/recordingCaptureMetadata.ts';
import {
  canUseWebCodecsVideoRecorder,
  createWebCodecsVideoTrackRecorder,
  resolveWebCodecsVideoRecorderConfig,
  type WebCodecsVideoRecorderConfig,
  type WebCodecsVideoTrackRecorder,
} from '../utils/webCodecsRecording.ts';
import {
  getPreferredAudioRecordingMimeType,
  getPreferredVideoRecordingMimeType,
  getRecordingFileExtension,
} from '../utils/recordingMimeTypes.ts';

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
  capture?: RecordingCaptureMetadata;
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
  capture: RecordingCaptureMetadata;
  sidecarResults: LocalRecordingFileResult[];
  webCodecsSidecar?: WebCodecsSidecarRecorder;
  activeWritable?: any; // FileSystemWritableFileStream
  fileHandle?: any; // FileSystemFileHandle
  getWritePromise: () => Promise<void> | null;
  cleanup?: () => void;
}

interface WebCodecsSidecarRecorder {
  id: string;
  label: string;
  kind: LocalRecordingSource['kind'];
  stream: MediaStream;
  recorder: WebCodecsVideoTrackRecorder;
  capture?: RecordingCaptureMetadata;
  started: boolean;
  cleanup: () => void;
}

interface StoppedTrackRecorderResult {
  blob: Blob | null;
  sidecars: LocalRecordingFileResult[];
}

export function useLocalRecording() {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [recordingLabels, setRecordingLabels] = useState<string[]>([]);

  const recordersRef = useRef<TrackRecorder[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const pausedAtRef = useRef<number | null>(null);
  const accumulatedPausedMsRef = useRef<number>(0);

  // Guard against double-stop
  const stoppingRef = useRef<boolean>(false);

  const getAudioMimeType = (): string => getPreferredAudioRecordingMimeType();

  const getVideoMimeType = (): string => getPreferredVideoRecordingMimeType();

  const getScreenMimeType = (): string => getPreferredVideoRecordingMimeType();

  const getElapsedSeconds = useCallback(() => {
    if (!startTimeRef.current) return 0;
    const endTime = pausedAtRef.current || Date.now();
    return Math.max(0, Math.floor((endTime - startTimeRef.current - accumulatedPausedMsRef.current) / 1000));
  }, []);

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

  const getEncoderMetadataForSource = (
    stream: MediaStream,
    mimeType: string,
    bitsPerSecond: number,
    webCodecsSidecarActive = false
  ): RecordingCaptureEncoderMetadata => {
    const hasVideo = stream.getVideoTracks().some((track) => track.readyState === 'live');
    const normalizedMimeType = mimeType.toLowerCase();
    const container = normalizedMimeType.includes('ogg')
      ? 'ogg'
      : normalizedMimeType.includes('audio/mp4')
        ? 'm4a'
        : normalizedMimeType.includes('mp4')
          ? 'mp4'
          : normalizedMimeType.includes('webm')
            ? 'webm'
            : 'browser';
    if (!hasVideo) {
      return {
        pipeline: 'media-recorder',
        container,
        fallbackReason: 'Audio-only sources use MediaRecorder for playable browser containers.',
      };
    }

    const webCodecsConfig = resolveWebCodecsVideoRecorderConfig({
      stream,
      contentType: mimeType,
      bitsPerSecond,
    });
    if (webCodecsSidecarActive && webCodecsConfig && canUseWebCodecsVideoRecorder()) {
      return {
        pipeline: 'media-recorder',
        container,
        codec: webCodecsConfig.config.codec,
        hardwareAcceleration: webCodecsConfig.config.hardwareAcceleration,
        fallbackReason: 'Playable browser primary captured with MediaRecorder; WebCodecs raw video sidecar captured for hardware-accelerated review.',
      };
    }

    if (webCodecsConfig && canUseWebCodecsVideoRecorder()) {
      return {
        pipeline: 'media-recorder',
        container,
        codec: webCodecsConfig.config.codec,
        hardwareAcceleration: webCodecsConfig.config.hardwareAcceleration,
        fallbackReason: 'WebCodecs VideoEncoder is available; raw bitstream sidecar starts when recording begins.',
      };
    }

    return {
      pipeline: 'media-recorder',
      container,
      fallbackReason: 'WebCodecs VideoEncoder or MediaStreamTrackProcessor is unavailable; using MediaRecorder for playable recording files.',
    };
  };

  const createWebCodecsSidecarRecorder = (
    source: LocalRecordingSource,
    stream: MediaStream,
    mimeType: string,
    bitsPerSecond: number
  ): WebCodecsSidecarRecorder | undefined => {
    if (!canUseWebCodecsVideoRecorder()) return undefined;
    const liveVideoTracks = stream.getVideoTracks().filter((track) => track.readyState === 'live');
    if (liveVideoTracks.length === 0) return undefined;

    const clonedTracks: MediaStreamTrack[] = [];
    const sidecarTracks = liveVideoTracks.map((track) => {
      if (typeof track.clone === 'function') {
        const clone = track.clone();
        clonedTracks.push(clone);
        return clone;
      }
      return track;
    });
    const sidecarStream = new MediaStream(sidecarTracks);
    const config = resolveWebCodecsVideoRecorderConfig({
      stream: sidecarStream,
      contentType: mimeType,
      bitsPerSecond,
    });
    if (!config) {
      clonedTracks.forEach((track) => track.stop());
      return undefined;
    }

    return {
      id: `${source.id}-webcodecs`,
      label: `${source.label} WebCodecs bitstream`,
      kind: source.kind,
      stream: sidecarStream,
      recorder: createWebCodecsVideoTrackRecorder({
        stream: sidecarStream,
        contentType: mimeType,
        bitsPerSecond,
      }),
      started: false,
      cleanup: () => clonedTracks.forEach((track) => track.stop()),
    };
  };

  const startWebCodecsSidecar = async (
    trackRecorder: TrackRecorder,
    startedAt: string
  ): Promise<void> => {
    const sidecar = trackRecorder.webCodecsSidecar;
    if (!sidecar) return;

    try {
      const config = await sidecar.recorder.start();
      sidecar.capture = createWebCodecsSidecarCapture(trackRecorder, sidecar, config, startedAt);
      sidecar.started = true;
      trackRecorder.capture = {
        ...trackRecorder.capture,
        encoder: getEncoderMetadataForSource(
          new MediaStream(trackRecorder.recorder.stream.getTracks()),
          trackRecorder.recorder.mimeType,
          trackRecorder.capture.requestedBitsPerSecond || 0,
          true
        ),
      };
    } catch (err) {
      console.warn(`WebCodecs sidecar disabled for ${trackRecorder.label}:`, err);
      sidecar.cleanup();
      trackRecorder.webCodecsSidecar = undefined;
    }
  };

  const createWebCodecsSidecarCapture = (
    trackRecorder: TrackRecorder,
    sidecar: WebCodecsSidecarRecorder,
    config: WebCodecsVideoRecorderConfig,
    startedAt: string
  ): RecordingCaptureMetadata => createRecordingCaptureMetadata({
    sourceId: sidecar.id,
    sourceKind: sidecar.kind,
    sourceLabel: sidecar.label,
    stream: sidecar.stream,
    mimeType: config.mimeType,
    requestedBitsPerSecond: Number(config.config.bitrate) || trackRecorder.capture.requestedBitsPerSecond || undefined,
    startedAt,
    encoder: {
      pipeline: 'webcodecs',
      container: 'raw-bitstream',
      codec: config.config.codec,
      hardwareAcceleration: config.config.hardwareAcceleration,
    },
  });

  const stopWebCodecsSidecar = async (
    sidecar: WebCodecsSidecarRecorder | undefined,
    stoppedAt: string
  ): Promise<LocalRecordingFileResult | null> => {
    if (!sidecar) return null;
    try {
      if (!sidecar.started) return null;
      const result = await sidecar.recorder.stop();
      const capture = finalizeRecordingCaptureMetadata(
        sidecar.capture || createRecordingCaptureMetadata({
          sourceId: sidecar.id,
          sourceKind: sidecar.kind,
          sourceLabel: sidecar.label,
          stream: sidecar.stream,
          mimeType: result.mimeType,
          requestedBitsPerSecond: Number(result.config.bitrate) || undefined,
          startedAt: new Date().toISOString(),
          encoder: {
            pipeline: 'webcodecs',
            container: 'raw-bitstream',
            codec: result.config.codec,
            hardwareAcceleration: result.config.hardwareAcceleration,
          },
        }),
        stoppedAt
      );
      return result.blob.size > 0
        ? { label: sidecar.label, kind: sidecar.kind, blob: result.blob, capture }
        : null;
    } catch (err) {
      console.warn(`WebCodecs sidecar stop failed for ${sidecar.label}:`, err);
      return null;
    } finally {
      sidecar.cleanup();
    }
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
        const ext = getRecordingFileExtension(mimeType);
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
    const webCodecsSidecar = createWebCodecsSidecarRecorder(source, stream, mimeType, bitsPerSecond);
    const capture = createRecordingCaptureMetadata({
      sourceId: source.id,
      sourceKind: source.kind,
      sourceLabel: source.label,
      stream,
      mimeType,
      requestedBitsPerSecond: bitsPerSecond,
      startedAt: new Date().toISOString(),
      encoder: getEncoderMetadataForSource(stream, mimeType, bitsPerSecond),
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
      capture,
      sidecarResults: [],
      webCodecsSidecar,
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
        const startedAt = new Date().toISOString();
        for (const trackRecorder of recorders) {
          trackRecorder.capture = { ...trackRecorder.capture, startedAt };
          trackRecorder.recorder.start(1000);
          await startWebCodecsSidecar(trackRecorder, startedAt);
        }
      } catch (err) {
        for (const trackRecorder of recorders) {
          try {
            if (trackRecorder.recorder.state !== 'inactive') trackRecorder.recorder.stop();
          } catch {
            // ignore failed cleanup after a start failure
          }
          await stopWebCodecsSidecar(trackRecorder.webCodecsSidecar, new Date().toISOString());
          trackRecorder.cleanup?.();
        }
        throw err;
      }
      recordersRef.current = recorders;
      setRecordingLabels(recorders.map((recorder) => recorder.label));

      // Start timer
      startTimeRef.current = Date.now();
      pausedAtRef.current = null;
      accumulatedPausedMsRef.current = 0;
      timerRef.current = setInterval(() => {
        setRecordingDuration(getElapsedSeconds());
      }, 1000);

      setIsRecording(true);
      setIsPaused(false);
      console.log(`Local recording started on disk/RAM: ${recorders.length} track(s)`);
    },
    [getElapsedSeconds, isRecording]
  );

  const pauseRecording = useCallback(async (): Promise<void> => {
    if (!isRecording || isPaused || stoppingRef.current) return;

    let pausedAny = false;
    for (const trackRecorder of recordersRef.current) {
      if (trackRecorder.recorder.state !== 'recording') continue;
      try {
        trackRecorder.recorder.pause();
        pausedAny = true;
      } catch (err) {
        console.warn(`Failed to pause local recording for ${trackRecorder.label}:`, err);
      }
    }

    if (!pausedAny) return;
    const pausedAt = Date.now();
    pausedAtRef.current = pausedAt;
    setRecordingDuration(getElapsedSeconds());
    setIsPaused(true);

    const stoppedAt = new Date(pausedAt).toISOString();
    await Promise.all(recordersRef.current.map(async (trackRecorder) => {
      const sidecar = await stopWebCodecsSidecar(trackRecorder.webCodecsSidecar, stoppedAt);
      if (sidecar) trackRecorder.sidecarResults.push(sidecar);
      trackRecorder.webCodecsSidecar = undefined;
    }));
  }, [getElapsedSeconds, isPaused, isRecording]);

  const resumeRecording = useCallback(async (): Promise<void> => {
    if (!isRecording || !isPaused || stoppingRef.current) return;

    let resumedAny = false;
    for (const trackRecorder of recordersRef.current) {
      if (trackRecorder.recorder.state !== 'paused') continue;
      try {
        trackRecorder.recorder.resume();
        resumedAny = true;
      } catch (err) {
        console.warn(`Failed to resume local recording for ${trackRecorder.label}:`, err);
      }
    }

    if (!resumedAny) return;
    const pausedAt = pausedAtRef.current;
    if (pausedAt !== null) {
      accumulatedPausedMsRef.current += Date.now() - pausedAt;
    }
    pausedAtRef.current = null;
    setRecordingDuration(getElapsedSeconds());
    setIsPaused(false);

    const startedAt = new Date().toISOString();
    await Promise.all(recordersRef.current.map(async (trackRecorder) => {
      if (trackRecorder.webCodecsSidecar) return;
      const bitsPerSecond = trackRecorder.capture.requestedBitsPerSecond;
      const source: LocalRecordingSource = {
        id: `${trackRecorder.id}-segment-${trackRecorder.sidecarResults.length + 1}`,
        label: trackRecorder.label,
        kind: trackRecorder.kind,
        stream: new MediaStream(trackRecorder.recorder.stream.getTracks().filter((track) => track.readyState === 'live')),
        ...(bitsPerSecond ? { bitsPerSecond } : {}),
      };
      const sidecar = createWebCodecsSidecarRecorder(
        source,
        source.stream,
        trackRecorder.recorder.mimeType,
        bitsPerSecond || 0
      );
      if (!sidecar) return;
      trackRecorder.webCodecsSidecar = sidecar;
      await startWebCodecsSidecar(trackRecorder, startedAt);
    }));
  }, [getElapsedSeconds, isPaused, isRecording]);

  const stopSingleRecorder = (
    trackRecorder: TrackRecorder | null,
    label: string
  ): Promise<StoppedTrackRecorderResult> => {
    return new Promise((resolve) => {
      if (!trackRecorder) {
        resolve({ blob: null, sidecars: [] });
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
        const stoppedAt = new Date().toISOString();
        trackRecorder.capture = finalizeRecordingCaptureMetadata(trackRecorder.capture, stoppedAt);
        const sidecar = await stopWebCodecsSidecar(trackRecorder.webCodecsSidecar, stoppedAt);
        const sidecars = sidecar ? [sidecar] : [];
        if (activeWritable) {
          try {
            const p = getWritePromise();
            if (p) await p; // wait for final chunk write
            await activeWritable.close();
            const file = await fileHandle.getFile();
            console.log(`${label} OPFS recording stopped. Size: ${(file.size / 1024 / 1024).toFixed(2)} MB`);
            cleanupSource();
            resolve({ blob: file, sidecars }); // returning File object maps to disk, doesn't load into RAM
            return;
          } catch (err) {
            console.error(`Error closing OPFS file for ${label}:`, err);
            // Fallthrough to memory chunks if OPFS threw error
          }
        }
        
        const blob = new Blob(chunks, { type: recorder.mimeType });
        console.log(`${label} RAM recording stopped. Size: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
        cleanupSource();
        resolve({ blob, sidecars });
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
    pausedAtRef.current = null;
    accumulatedPausedMsRef.current = 0;

    const activeRecorders = [...recordersRef.current];
    const stopPromises = activeRecorders.map((trackRecorder) => stopSingleRecorder(trackRecorder, trackRecorder.label));

    return Promise.all(stopPromises).then(
      (results) => {
        // Clean up refs
        recordersRef.current = [];

        setIsRecording(false);
        setIsPaused(false);
        setRecordingDuration(0);
        setRecordingLabels([]);
        stoppingRef.current = false;

        const files = activeRecorders.flatMap((recorder, index): LocalRecordingFileResult[] => {
          const result = results[index];
          const primary = result.blob && result.blob.size > 0
            ? [{ label: recorder.label, kind: recorder.kind, blob: result.blob, capture: recorder.capture }]
            : [];
          return [...primary, ...recorder.sidecarResults, ...result.sidecars];
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

  const discardSingleRecorder = async (trackRecorder: TrackRecorder): Promise<void> => {
    await stopWebCodecsSidecar(trackRecorder.webCodecsSidecar, new Date().toISOString());
    trackRecorder.webCodecsSidecar = undefined;

    await new Promise<void>((resolve) => {
      const { recorder } = trackRecorder;
      if (recorder.state === 'inactive') {
        resolve();
        return;
      }
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = () => resolve();
      try {
        recorder.stop();
      } catch {
        resolve();
      }
    });

    try {
      const writePromise = trackRecorder.getWritePromise();
      if (writePromise) await writePromise.catch(() => undefined);
      await trackRecorder.activeWritable?.close?.();
    } catch {
      // Cancel discards recording data, so failed close cleanup is non-fatal.
    }
    trackRecorder.cleanup?.();
  };

  const cancelRecording = useCallback(async (): Promise<void> => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;

    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    pausedAtRef.current = null;
    accumulatedPausedMsRef.current = 0;

    const activeRecorders = [...recordersRef.current];
    await Promise.all(activeRecorders.map(discardSingleRecorder));

    recordersRef.current = [];
    setIsRecording(false);
    setIsPaused(false);
    setRecordingDuration(0);
    setRecordingLabels([]);
    stoppingRef.current = false;
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
        if (trackRecorder) {
          try {
            if (trackRecorder.recorder.state !== 'inactive') {
              trackRecorder.recorder.stop();
            }
            void stopWebCodecsSidecar(trackRecorder.webCodecsSidecar, new Date().toISOString());
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
      pausedAtRef.current = null;
      accumulatedPausedMsRef.current = 0;
    };
  }, []);

  return {
    isRecording,
    isPaused,
    formattedTime: formatTime(recordingDuration),
    recordingLabels,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    cancelRecording,
  };
}
