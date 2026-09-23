import { useState, useRef, useCallback, useEffect } from 'react';
import { createRecoverableRecordingStore } from '../utils/recordingRecovery.ts';
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
} from '../utils/recordingMimeTypes.ts';
import {
  createProgressiveRecordingUploader,
  isProgressiveUploadMimeType,
  toProgressiveUploadTrackId,
  type ProgressiveRecordingUploader,
  type ProgressiveRecordingUploaderOptions,
  type ProgressiveUploadResult,
  type ProgressiveUploadState,
  type ProgressiveUploadTrackCompletion,
} from '../utils/progressiveRecordingUpload.ts';

export interface RecordingResult {
  audio: Blob;
  video: Blob;
  screen?: Blob;
  program?: Blob;
  files: LocalRecordingFileResult[];
  /** Present when the take was uploaded progressively; finishes the remaining bytes. */
  progressiveUpload?: {
    finish(): Promise<ProgressiveUploadResult>;
  };
}

export interface LocalRecordingFileResult {
  label: string;
  blob: Blob;
  kind: LocalRecordingSource['kind'];
  capture?: RecordingCaptureMetadata;
  /** Recorder source id; set on primary tracks (not WebCodecs sidecars). */
  sourceId?: string;
}

/** Everything the progressive uploader needs except the tracks, which the hook supplies. */
export type LocalProgressiveUploadConfig = Pick<
  ProgressiveRecordingUploaderOptions,
  'mediaHttpUrl' | 'roomId' | 'sessionId' | 'participantId' | 'participantName' | 'getToken' | 'tokenRefreshMs'
>;

export interface StartLocalRecordingOptions {
  progressiveUpload?: LocalProgressiveUploadConfig;
}

interface ActiveProgressiveUpload {
  uploader: ProgressiveRecordingUploader;
  trackIds: Map<string, string>;
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
  chunkStore: ReturnType<typeof createRecoverableRecordingStore>;
  finished: Promise<Blob>;
  started: boolean;
  capture: RecordingCaptureMetadata;
  sidecarResults: LocalRecordingFileResult[];
  webCodecsSidecar?: WebCodecsSidecarRecorder;
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

export function useLocalRecording(roomName = 'Studio') {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const startingRef = useRef(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [recordingLabels, setRecordingLabels] = useState<string[]>([]);

  const [uploadState, setUploadState] = useState<ProgressiveUploadState | null>(null);
  const recordersRef = useRef<TrackRecorder[]>([]);
  const progressiveUploadRef = useRef<ActiveProgressiveUpload | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const pausedAtRef = useRef<number | null>(null);
  const accumulatedPausedMsRef = useRef<number>(0);

  // Guard against double-stop
  const stoppingRef = useRef<boolean>(false);
  const stopPromiseRef = useRef<Promise<RecordingResult> | null>(null);
  const generationRef = useRef(0);

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

  const createTrackRecorder = async (source: LocalRecordingSource): Promise<TrackRecorder | null> => {
    const stream = new MediaStream(source.stream.getTracks().filter((track) => track.readyState === 'live'));
    if (stream.getTracks().length === 0) return null;
    const mimeType = getMimeTypeForSource({ ...source, stream });
    const bitsPerSecond = getBitsPerSecondForSource({ ...source, stream });
    if (!mimeType) {
      console.error(`No supported MIME type for ${source.label} recording`);
      return null;
    }

    const recorder = new MediaRecorder(stream, { mimeType, bitsPerSecond });
    const chunkStore = createRecoverableRecordingStore({
      roomName, label: source.label, kind: source.kind, mimeType: recorder.mimeType,
    }, () => setStorageWarning('Recording is continuing in memory. Keep this tab open until it has been saved.'));
    // Finalize even when capture stops unexpectedly, after its final data event.
    let resolveFinished!: (blob: Blob) => void;
    let rejectFinished!: (error: unknown) => void;
    const finished = new Promise<Blob>((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
    recorder.onstop = () => { void chunkStore.finish(recorder.mimeType).then(resolveFinished, rejectFinished); };
    void finished.catch(() => {});
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

    recorder.ondataavailable = (event) => chunkStore.append(event.data);

    recorder.onerror = (e) => {
      console.error(`Recording error for ${source.label}:`, e);
      setStorageWarning('A recording track was interrupted. Stop and save the available footage.');
    };

    return {
      id: source.id,
      label: source.label,
      kind: source.kind,
      recorder,
      chunkStore,
      finished,
      started: false,
      capture,
      sidecarResults: [],
      webCodecsSidecar,
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

  const startProgressiveUpload = (recorders: TrackRecorder[], config: LocalProgressiveUploadConfig) => {
    const mimeTypes = recorders.map((recorder) => recorder.recorder.mimeType || '');
    if (mimeTypes.some((mimeType) => !isProgressiveUploadMimeType(mimeType))) {
      // The media server accepts WebM/MP4 only; the finished files use the regular upload path.
      setUploadState(null);
      return;
    }
    const seen = new Set<string>();
    const trackIds = new Map<string, string>();
    const sources = recorders.map((recorder, index) => {
      const id = toProgressiveUploadTrackId(recorder.id, index, seen);
      trackIds.set(recorder.id, id);
      const mimeType = recorder.recorder.mimeType;
      return {
        id,
        label: recorder.label,
        kind: recorder.kind,
        mimeType,
        capture: recorder.capture as unknown as Record<string, unknown>,
        snapshot: () => recorder.chunkStore.snapshot(mimeType),
      };
    });
    const uploader = createProgressiveRecordingUploader({
      ...config,
      onChange: (state) => setUploadState(state),
    });
    progressiveUploadRef.current = { uploader, trackIds };
    uploader.start(sources);
  };

  const pauseUpload = useCallback(() => {
    progressiveUploadRef.current?.uploader.pause();
  }, []);

  const resumeUpload = useCallback(() => {
    progressiveUploadRef.current?.uploader.resume();
  }, []);

  const startRecording = useCallback(
    async (
      input: MediaStream | LocalRecordingSource[],
      screenStream?: MediaStream | null,
      options?: StartLocalRecordingOptions
    ) => {
      // Guard against double-start
      if (startingRef.current || recordersRef.current.length || stoppingRef.current) return;
      startingRef.current = true;
      setStorageWarning(null);
      stopPromiseRef.current = null;
      const generation = generationRef.current;
      try {
        const sources = (Array.isArray(input) ? input : getDefaultSources(input, screenStream))
          .map((source) => ({
            ...source,
            stream: new MediaStream(source.stream.getTracks().filter((track) => track.readyState === 'live')),
          }))
          .filter((source) => source.stream.getTracks().length > 0);
        if (sources.length === 0) return;

        const recorders: TrackRecorder[] = [];
        recordersRef.current = recorders;
        for (const source of sources) {
          if (generation !== generationRef.current) { source.cleanup?.(); continue; }
          try {
            const trackRecorder = await createTrackRecorder(source);
            if (trackRecorder) {
              if (generation !== generationRef.current) {
                await trackRecorder.chunkStore.discard();
                source.cleanup?.();
              } else recorders.push(trackRecorder);
            } else source.cleanup?.();
          } catch (error) {
            source.cleanup?.();
            setStorageWarning(`Could not start the ${source.label} track. Other available tracks can still record.`);
          }
        }
        if (recorders.length === 0) return;

        // Start all recorders with 1-second chunks
        try {
          const startedAt = new Date().toISOString();
          for (const trackRecorder of recorders) {
            trackRecorder.capture = { ...trackRecorder.capture, startedAt };
            if (generation !== generationRef.current) throw new Error('Studio closed before recording started.');
            trackRecorder.recorder.start(1000);
            trackRecorder.started = true;
            await startWebCodecsSidecar(trackRecorder, startedAt);
          }
          if (generation !== generationRef.current) throw new Error('Studio closed before recording started.');
        } catch (err) {
          for (const trackRecorder of recorders) {
            try {
              if (trackRecorder.recorder.state !== 'inactive') trackRecorder.recorder.stop();
            } catch {
              // ignore failed cleanup after a start failure
            }
            await stopWebCodecsSidecar(trackRecorder.webCodecsSidecar, new Date().toISOString());
            if (!trackRecorder.started) await trackRecorder.chunkStore.discard();
            trackRecorder.cleanup?.();
          }
          recordersRef.current = [];
          throw err;
        }
        recordersRef.current = recorders;
        setRecordingLabels(recorders.map((recorder) => recorder.label));
        progressiveUploadRef.current?.uploader.stop();
        progressiveUploadRef.current = null;
        setUploadState(null);
        if (options?.progressiveUpload) {
          try {
            startProgressiveUpload(recorders, options.progressiveUpload);
          } catch (err) {
            console.warn('Progressive recording upload could not start; the take uploads after it ends:', err);
          }
        }

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
      } finally { startingRef.current = false; }
    },
    [getElapsedSeconds, roomName]
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

  const stopSingleRecorder = async (trackRecorder: TrackRecorder): Promise<StoppedTrackRecorderResult> => {
    const { recorder, chunkStore, cleanup } = trackRecorder;
    try {
      let stopFailed = false;
      if (recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { stopFailed = true; }
      }
      // Wait for MediaRecorder's final data event, including spontaneous stops.
      const blob = await (stopFailed ? chunkStore.finish(recorder.mimeType) : trackRecorder.finished);
      const stoppedAt = new Date().toISOString();
      trackRecorder.capture = finalizeRecordingCaptureMetadata(trackRecorder.capture, stoppedAt);
      const sidecar = await stopWebCodecsSidecar(trackRecorder.webCodecsSidecar, stoppedAt);
      return { blob, sidecars: sidecar ? [sidecar] : [] };
    } finally { cleanup?.(); }
  };

  const stopRecording = useCallback((): Promise<RecordingResult> => {
    // Guard against double-stop
    if (stopPromiseRef.current) return stopPromiseRef.current;
    if (stoppingRef.current) return Promise.reject(new Error('Recording cancellation is still in progress.'));
    stoppingRef.current = true;

    // Stop timer
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    pausedAtRef.current = null;
    accumulatedPausedMsRef.current = 0;

    const activeRecorders = [...recordersRef.current];
    const activeUpload = progressiveUploadRef.current;
    progressiveUploadRef.current = null;
    // Halt background cycles; finish() still uploads the remainder when the caller asks.
    activeUpload?.uploader.stop();
    const stopPromises = activeRecorders.map((trackRecorder) => stopSingleRecorder(trackRecorder));

    stopPromiseRef.current = Promise.all(stopPromises).then(
      (results) => {
        const files = activeRecorders.flatMap((recorder, index): LocalRecordingFileResult[] => {
          const result = results[index];
          const primary = result.blob && result.blob.size > 0
            ? [{ label: recorder.label, kind: recorder.kind, blob: result.blob, capture: recorder.capture, sourceId: recorder.id }]
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

        if (activeUpload) {
          const finalBlobs = new Map<string, Blob>();
          const metadata = new Map<string, ProgressiveUploadTrackCompletion>();
          activeRecorders.forEach((recorder, index) => {
            const trackId = activeUpload.trackIds.get(recorder.id);
            if (!trackId) return;
            finalBlobs.set(trackId, results[index].blob || new Blob([], { type: recorder.recorder.mimeType }));
            metadata.set(trackId, {
              durationMs: recorder.capture.durationMs,
              capture: recorder.capture as unknown as Record<string, unknown>,
            });
          });
          result.progressiveUpload = {
            finish: () => activeUpload.uploader.finish(finalBlobs, metadata),
          };
        }

        console.log('Local recording stopped completely.');
        return result;
      }
    ).finally(() => {
      recordersRef.current = [];
      setIsRecording(false); setIsPaused(false); setRecordingDuration(0); setRecordingLabels([]);
      stoppingRef.current = false;
    });
    return stopPromiseRef.current;
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

    await trackRecorder.chunkStore.discard();
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
    progressiveUploadRef.current?.uploader.stop();
    progressiveUploadRef.current = null;
    setUploadState(null);
    await Promise.all(activeRecorders.map(discardSingleRecorder));

    recordersRef.current = [];
    stopPromiseRef.current = null;
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
      generationRef.current++;
      progressiveUploadRef.current?.uploader.stop();
      progressiveUploadRef.current = null;
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
            if (!trackRecorder.started) void trackRecorder.chunkStore.discard();
            else void trackRecorder.chunkStore.flush();
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
    storageWarning,
    recordingLabels,
    uploadState,
    pauseUpload,
    resumeUpload,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    cancelRecording,
  };
}
