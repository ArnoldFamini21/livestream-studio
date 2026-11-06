import { useState, useRef, useCallback, useEffect } from 'react';
import type { RecordingRecoveryTransferMetadata } from '../utils/recordingRecovery.ts';
import {
  browserRecordingTrackStoreFactory,
  type RecordingTrackStore,
  type RecordingTrackStoreFactory,
} from '../utils/recordingTrackStore.ts';
import { getStreamRecordingVideoBitsPerSecond } from '../utils/recordingBitrate.ts';
import {
  createCaptureTimeline,
  pauseCaptureTimeline,
  resumeCaptureTimeline,
  stopCaptureTimeline,
  timelineNow,
} from '../utils/recordingTakeManifest.ts';
import { PcmWavRecorder, openRawMicrophone } from '../utils/pcmWavRecorder.ts';
import type { TransferSourceTrack } from '../utils/recordingTransferSession.ts';
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
import { reportClientError } from '../utils/clientErrorReporter.ts';

/** Audio rate beside a camera or screen track in a local recording. */
const LOCAL_RECORDING_AUDIO_BITS_PER_SECOND = 256_000;

export interface RecordingResult {
  audio: Blob;
  video: Blob;
  screen?: Blob;
  program?: Blob;
  files: LocalRecordingFileResult[];
  /** Present when the take was uploaded progressively; finishes the remaining bytes. */
  progressiveUpload?: {
    finish(): Promise<ProgressiveUploadResult>;
    /** Files (later segments, mid-take screen shares) the upload session does not include. */
    uncoveredFiles: LocalRecordingFileResult[];
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
  /** Opt in to capturing a raw WebCodecs bitstream sidecar alongside playable MediaRecorder video files. */
  enableWebCodecsSidecar?: boolean;
  /** Where track bytes land: the host's recording folder, or browser storage (default). */
  storage?: RecordingTrackStoreFactory;
  /** Tags browser backups with the take, so they can be resumed and sent to the host. */
  transfer?: Omit<RecordingRecoveryTransferMetadata, 'sourceId' | 'segmentIndex' | 'capture'>;
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
  enableWebCodecsSidecar?: boolean;
  cleanup?: () => void;
  /** 'wav' records lossless 48 kHz PCM from the (raw) microphone instead of MediaRecorder. */
  format?: 'wav';
  /** Microphone device for the raw (unprocessed) WAV capture. */
  rawDeviceId?: string;
}

interface TrackRecorder {
  id: string;
  label: string;
  kind: LocalRecordingSource['kind'];
  recorder: MediaRecorder;
  chunkStore: RecordingTrackStore;
  /** Source id shared by every segment of the source. */
  sourceId: string;
  /** Base label without a segment suffix. */
  baseLabel: string;
  segmentIndex: number;
  /** The live input tracks this recorder captures, to detect device changes. */
  inputTrackIds: string[];
  wav?: PcmWavRecorder;
  detachEnded?: () => void;
  finished: Promise<Blob>;
  started: boolean;
  capture: RecordingCaptureMetadata;
  enableWebCodecsSidecar: boolean;
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
  /** Bumps when a recorded input track ends (device switch, screen share stopped). */
  const [inputEndedVersion, setInputEndedVersion] = useState(0);
  /** Bumps when the list of transferable tracks changes or a track finishes. */
  const [transferVersion, setTransferVersion] = useState(0);
  const recordersRef = useRef<TrackRecorder[]>([]);
  const startOptionsRef = useRef<StartLocalRecordingOptions | undefined>(undefined);
  /** Segments that ended mid-take (device changes); returned with the take. */
  const retiredRef = useRef<Array<{ recorder: TrackRecorder; result: StoppedTrackRecorderResult }>>([]);
  const segmentCountsRef = useRef(new Map<string, number>());
  const updatingRef = useRef(false);
  const transferTracksRef = useRef(new Map<string, TransferSourceTrack & { store: RecordingTrackStore }>());
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
    const hasVideo = source.stream.getVideoTracks().some((track) => track.readyState === 'live');
    // Scale with the captured resolution: 720p 5 Mbps, 1080p 10, 4K 40.
    return hasVideo ? getStreamRecordingVideoBitsPerSecond(source.stream) : 256_000;
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
        fallbackReason: 'WebCodecs VideoEncoder is available; playable browser primary captured with MediaRecorder (raw bitstream sidecar is opt-in).',
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

  const createTrackRecorder = async (
    source: LocalRecordingSource,
    enableWebCodecsSidecarOption = false,
    segmentIndex = 0,
  ): Promise<TrackRecorder | null> => {
    const stream = new MediaStream(source.stream.getTracks().filter((track) => track.readyState === 'live'));
    if (stream.getTracks().length === 0) return null;
    const recorderId = segmentIndex ? `${source.id}-part${segmentIndex + 1}` : source.id;
    const label = segmentIndex ? `${source.label} (part ${segmentIndex + 1})` : source.label;
    let wav: PcmWavRecorder | undefined;
    let recorder: MediaRecorder;
    let rawCleanup: (() => void) | undefined;
    const bitsPerSecond = getBitsPerSecondForSource({ ...source, stream });
    let mimeType = '';
    if (source.format === 'wav') {
      // Lossless mic: prefer an unprocessed capture of the same microphone.
      const raw = await openRawMicrophone(source.rawDeviceId);
      if (raw) rawCleanup = () => raw.stop();
      wav = new PcmWavRecorder(raw ? new MediaStream([raw]) : new MediaStream(stream.getAudioTracks()));
      // PcmWavRecorder implements the MediaRecorder surface used below.
      recorder = wav as unknown as MediaRecorder;
      mimeType = wav.mimeType;
    } else {
      mimeType = getMimeTypeForSource({ ...source, stream });
      if (!mimeType) {
        console.error(`No supported MIME type for ${source.label} recording`);
        return null;
      }
      // Separate rates: with one combined figure Chrome gives audio 10% of it
      // (850 kbps for an 8.5 Mbps camera) and then clamps it to 510 kbps.
      const hasVideo = stream.getVideoTracks().length > 0;
      const hasAudio = stream.getAudioTracks().length > 0;
      recorder = new MediaRecorder(stream, {
        mimeType,
        ...(hasVideo ? { videoBitsPerSecond: bitsPerSecond } : {}),
        ...(hasAudio ? { audioBitsPerSecond: hasVideo ? LOCAL_RECORDING_AUDIO_BITS_PER_SECOND : bitsPerSecond } : {}),
      });
    }
    const startOptions = startOptionsRef.current;
    const chunkStore = (startOptions?.storage || browserRecordingTrackStoreFactory)({
      roomName,
      label,
      kind: source.kind,
      mimeType: recorder.mimeType || mimeType,
      sourceId: source.id,
      ...(startOptions?.transfer ? { transfer: { ...startOptions.transfer, sourceId: source.id, segmentIndex } } : {}),
    }, (message) => setStorageWarning(message));
    // Finalize even when capture stops unexpectedly, after its final data event.
    let resolveFinished!: (blob: Blob) => void;
    let rejectFinished!: (error: unknown) => void;
    const finished = new Promise<Blob>((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
    recorder.onstop = () => {
      const header = wav ? new Blob([wav.headerBytes() as BlobPart], { type: wav.mimeType }) : undefined;
      void chunkStore.finish(recorder.mimeType, header ? { header } : undefined).then(resolveFinished, rejectFinished);
    };
    // A device switch stops the old input track; the caller then continues
    // the source in a new segment file.
    const inputTracks = stream.getTracks();
    const onInputEnded = () => setInputEndedVersion((version) => version + 1);
    inputTracks.forEach((track) => track.addEventListener('ended', onInputEnded));
    const detachEnded = () => inputTracks.forEach((track) => track.removeEventListener('ended', onInputEnded));
    void finished.catch(() => {});
    const enableWebCodecsSidecar = Boolean(source.enableWebCodecsSidecar ?? enableWebCodecsSidecarOption);
    const webCodecsSidecar = enableWebCodecsSidecar
      ? createWebCodecsSidecarRecorder(source, stream, mimeType, bitsPerSecond)
      : undefined;
    const capture = createRecordingCaptureMetadata({
      sourceId: source.id,
      sourceKind: source.kind,
      sourceLabel: label,
      stream: wav ? wav.stream : stream,
      mimeType,
      requestedBitsPerSecond: wav ? wav.format.sampleRate * wav.format.channels * wav.format.bitsPerSample : bitsPerSecond,
      startedAt: new Date().toISOString(),
      encoder: wav
        ? { pipeline: 'media-recorder', container: 'browser', codec: `pcm_s${wav.format.bitsPerSample}le`, fallbackReason: 'Lossless 48 kHz PCM captured with an AudioWorklet.' }
        : getEncoderMetadataForSource(stream, mimeType, bitsPerSecond),
    });

    recorder.ondataavailable = (event) => chunkStore.append(event.data);

    recorder.onerror = (e) => {
      console.error(`Recording error for ${source.label}:`, e);
      reportClientError('recording', `A local recording track (${source.kind}) was interrupted.`);
      setStorageWarning('A recording track was interrupted. Stop and save the available footage.');
    };

    return {
      id: recorderId,
      sourceId: source.id,
      label,
      baseLabel: source.label,
      segmentIndex,
      inputTrackIds: inputTracks.map((track) => track.id),
      kind: source.kind,
      recorder,
      chunkStore,
      finished,
      started: false,
      capture,
      enableWebCodecsSidecar: enableWebCodecsSidecar && !wav,
      sidecarResults: [],
      webCodecsSidecar: wav ? undefined : webCodecsSidecar,
      wav,
      detachEnded,
      cleanup: () => { detachEnded(); rawCleanup?.(); source.cleanup?.(); },
    };
  };

  const bumpTransfer = () => setTransferVersion((version) => version + 1);

  /** Make a started recorder available to the peer-to-peer transfer. */
  const registerTransferTrack = (trackRecorder: TrackRecorder) => {
    const transfer = startOptionsRef.current?.transfer;
    if (!transfer) return;
    const mimeType = trackRecorder.recorder.mimeType;
    transferTracksRef.current.set(trackRecorder.chunkStore.id, {
      id: trackRecorder.chunkStore.id,
      sessionId: transfer.sessionId,
      label: trackRecorder.label,
      kind: trackRecorder.kind,
      mimeType,
      ...(trackRecorder.wav ? { lossless: true } : {}),
      store: trackRecorder.chunkStore,
      read: () => trackRecorder.chunkStore.snapshot(mimeType),
    });
    bumpTransfer();
  };

  const completeTransferTrack = (trackRecorder: TrackRecorder, blob: Blob | null) => {
    const entry = transferTracksRef.current.get(trackRecorder.chunkStore.id);
    if (!entry) return;
    const finalBlob = blob || new Blob([], { type: entry.mimeType });
    entry.read = async () => finalBlob;
    entry.finished = {
      totalBytes: finalBlob.size,
      ...(trackRecorder.wav ? { header: trackRecorder.wav.headerBytes() } : {}),
      capture: trackRecorder.capture,
    };
    void trackRecorder.chunkStore.updateTransferCapture?.(trackRecorder.capture)?.catch(() => {});
    bumpTransfer();
  };

  /** Start a recorder now (also used for segments added mid-take). */
  const startTrackRecorder = (trackRecorder: TrackRecorder, paused: boolean) => {
    const trackStartedAt = new Date().toISOString();
    let timeline = createCaptureTimeline(trackRecorder.segmentIndex, timelineNow());
    trackRecorder.recorder.start(1000);
    trackRecorder.started = true;
    if (paused) {
      try { trackRecorder.recorder.pause(); } catch { /* Keep recording rather than lose it. */ }
      timeline = pauseCaptureTimeline(timeline, timeline.startMs);
    }
    trackRecorder.capture = { ...trackRecorder.capture, startedAt: trackStartedAt, timeline };
    registerTransferTrack(trackRecorder);
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
      });
    }

    if (screenStream && screenStream.getTracks().some((track) => track.readyState === 'live')) {
      sources.push({
        id: 'screen',
        label: 'Screen',
        kind: 'screen',
        stream: screenStream,
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
      startOptionsRef.current = options;
      retiredRef.current = [];
      segmentCountsRef.current = new Map();
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
            const trackRecorder = await createTrackRecorder(source, Boolean(options?.enableWebCodecsSidecar));
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

        // Start all primary MediaRecorder tracks synchronously first so optional sidecars never delay track start
        try {
          for (const trackRecorder of recorders) {
            if (generation !== generationRef.current) throw new Error('Studio closed before recording started.');
            startTrackRecorder(trackRecorder, false);
            segmentCountsRef.current.set(trackRecorder.sourceId, 1);
          }
          await Promise.all(
            recorders.map((trackRecorder) => startWebCodecsSidecar(trackRecorder, trackRecorder.capture.startedAt))
          );
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
    const pausedTimelineAt = timelineNow();
    for (const trackRecorder of recordersRef.current) {
      if (trackRecorder.capture.timeline) {
        trackRecorder.capture = { ...trackRecorder.capture, timeline: pauseCaptureTimeline(trackRecorder.capture.timeline, pausedTimelineAt) };
      }
    }
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
    const resumedTimelineAt = timelineNow();
    for (const trackRecorder of recordersRef.current) {
      if (trackRecorder.capture.timeline) {
        trackRecorder.capture = { ...trackRecorder.capture, timeline: resumeCaptureTimeline(trackRecorder.capture.timeline, resumedTimelineAt) };
      }
    }
    const pausedAt = pausedAtRef.current;
    if (pausedAt !== null) {
      accumulatedPausedMsRef.current += Date.now() - pausedAt;
    }
    pausedAtRef.current = null;
    setRecordingDuration(getElapsedSeconds());
    setIsPaused(false);

    await Promise.all(recordersRef.current.map(async (trackRecorder) => {
      if (!trackRecorder.enableWebCodecsSidecar || trackRecorder.webCodecsSidecar) return;
      const startedAt = new Date().toISOString();
      const bitsPerSecond = trackRecorder.capture.requestedBitsPerSecond;
      const source: LocalRecordingSource = {
        id: `${trackRecorder.id}-segment-${trackRecorder.sidecarResults.length + 1}`,
        label: trackRecorder.label,
        kind: trackRecorder.kind,
        stream: new MediaStream(trackRecorder.recorder.stream.getTracks().filter((track) => track.readyState === 'live')),
        ...(bitsPerSecond ? { bitsPerSecond } : {}),
        enableWebCodecsSidecar: true,
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
      const stopTimelineAt = timelineNow();
      // Wait for MediaRecorder's final data event, including spontaneous stops.
      const blob = await (stopFailed ? chunkStore.finish(recorder.mimeType) : trackRecorder.finished);
      const stoppedAt = new Date().toISOString();
      const timeline = trackRecorder.capture.timeline;
      trackRecorder.capture = finalizeRecordingCaptureMetadata(
        timeline ? { ...trackRecorder.capture, timeline: stopCaptureTimeline(timeline, stopTimelineAt) } : trackRecorder.capture,
        stoppedAt,
      );
      completeTransferTrack(trackRecorder, blob);
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

    const liveRecorders = [...recordersRef.current];
    const retired = retiredRef.current;
    retiredRef.current = [];
    const activeUpload = progressiveUploadRef.current;
    progressiveUploadRef.current = null;
    // Halt background cycles; finish() still uploads the remainder when the caller asks.
    activeUpload?.uploader.stop();
    const stopPromises = liveRecorders.map((trackRecorder) => stopSingleRecorder(trackRecorder));

    stopPromiseRef.current = Promise.all(stopPromises).then(
      (liveResults) => {
        // Earlier segments (before a device change) come first, in capture order.
        const activeRecorders = [...retired.map((entry) => entry.recorder), ...liveRecorders];
        const results = [...retired.map((entry) => entry.result), ...liveResults];
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
          // Segments and tracks added mid-take are not part of the upload session.
          const uncoveredFiles = activeRecorders.flatMap((recorder, index) => {
            const blob = results[index].blob;
            if (activeUpload.trackIds.has(recorder.id) || !blob || blob.size === 0) return [];
            return [{ label: recorder.label, kind: recorder.kind, blob, capture: recorder.capture, sourceId: recorder.id }];
          });
          result.progressiveUpload = {
            finish: () => activeUpload.uploader.finish(finalBlobs, metadata),
            uncoveredFiles,
          };
        }

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
    const retired = retiredRef.current;
    retiredRef.current = [];
    progressiveUploadRef.current?.uploader.stop();
    progressiveUploadRef.current = null;
    setUploadState(null);
    await Promise.all(activeRecorders.map(discardSingleRecorder));
    await Promise.all(retired.map((entry) => entry.recorder.chunkStore.discard().catch(() => {})));
    for (const entry of [...activeRecorders, ...retired.map((item) => item.recorder)]) {
      transferTracksRef.current.delete(entry.chunkStore.id);
    }

    recordersRef.current = [];
    stopPromiseRef.current = null;
    setIsRecording(false);
    setIsPaused(false);
    setRecordingDuration(0);
    setRecordingLabels([]);
    stoppingRef.current = false;
  }, []);

  /**
   * Keep every source recording through device and setting changes: a
   * source whose input tracks changed (new mic, camera, processing or quality)
   * continues in a new segment file; a source that appears mid-take (a screen
   * share) gets its own track; a source whose inputs all ended is closed.
   */
  const updateSources = useCallback(async (input: LocalRecordingSource[]): Promise<void> => {
    const cleanupAll = () => input.forEach((source) => source.cleanup?.());
    if (!recordersRef.current.length || startingRef.current || stoppingRef.current || updatingRef.current) {
      cleanupAll();
      return;
    }
    updatingRef.current = true;
    const generation = generationRef.current;
    try {
      const sources = input
        .map((source) => ({ ...source, stream: new MediaStream(source.stream.getTracks().filter((track) => track.readyState === 'live')) }))
        .filter((source) => source.stream.getTracks().length > 0);
      const bySource = new Map(sources.map((source) => [source.id, source]));
      const used = new Set<string>();
      const kept: TrackRecorder[] = [];
      const toRetire: TrackRecorder[] = [];
      const toStart: Array<{ source: LocalRecordingSource; segmentIndex: number }> = [];

      for (const trackRecorder of recordersRef.current) {
        const source = bySource.get(trackRecorder.sourceId);
        const inputs = trackRecorder.wav ? trackRecorder.wav.stream.getTracks() : trackRecorder.recorder.stream.getTracks();
        const allEnded = trackRecorder.recorder.state === 'inactive' || inputs.every((track) => track.readyState === 'ended');
        if (!source) {
          if (allEnded) toRetire.push(trackRecorder); else kept.push(trackRecorder);
          continue;
        }
        used.add(source.id);
        const sourceTrackIds = source.stream.getTracks().map((track) => track.id).sort().join(',');
        const recordedTrackIds = [...trackRecorder.inputTrackIds].sort().join(',');
        if (sourceTrackIds === recordedTrackIds && !allEnded) {
          kept.push(trackRecorder);
          continue;
        }
        toRetire.push(trackRecorder);
        const segmentIndex = segmentCountsRef.current.get(source.id) || trackRecorder.segmentIndex + 1;
        toStart.push({ source, segmentIndex });
      }
      for (const source of sources) {
        if (used.has(source.id)) continue;
        used.add(source.id);
        toStart.push({ source, segmentIndex: segmentCountsRef.current.get(source.id) || 0 });
      }
      for (const source of input) {
        if (!toStart.some((entry) => entry.source.id === source.id)) source.cleanup?.();
      }
      if (!toRetire.length && !toStart.length) return;

      const started: TrackRecorder[] = [];
      for (const { source, segmentIndex } of toStart) {
        if (generation !== generationRef.current || stoppingRef.current) { source.cleanup?.(); continue; }
        try {
          const trackRecorder = await createTrackRecorder(source, Boolean(startOptionsRef.current?.enableWebCodecsSidecar), segmentIndex);
          if (!trackRecorder) { source.cleanup?.(); continue; }
          startTrackRecorder(trackRecorder, pausedAtRef.current !== null);
          segmentCountsRef.current.set(source.id, segmentIndex + 1);
          started.push(trackRecorder);
        } catch (error) {
          source.cleanup?.();
          console.warn(`Could not continue the ${source.label} track:`, error);
          setStorageWarning(`The ${source.label} track could not continue after a device change.`);
        }
      }
      if (stoppingRef.current || generation !== generationRef.current) {
        await Promise.all(started.map(discardSingleRecorder));
        return;
      }
      recordersRef.current = [...kept, ...started];
      setRecordingLabels(recordersRef.current.map((recorder) => recorder.label));
      // Close the old segments after the new ones are running, so no audio is lost.
      for (const trackRecorder of toRetire) {
        try {
          const result = await stopSingleRecorder(trackRecorder);
          retiredRef.current.push({ recorder: trackRecorder, result });
        } catch (error) {
          console.warn(`A recording segment for ${trackRecorder.label} could not be closed:`, error);
        }
      }
    } finally {
      updatingRef.current = false;
    }
  }, [roomName]);

  /** Stop the background media-server upload (the host collects tracks directly). */
  const cancelUpload = useCallback(() => {
    progressiveUploadRef.current?.uploader.stop();
    progressiveUploadRef.current = null;
    setUploadState(null);
  }, []);

  /** Tracks of this page's takes that can be streamed to the host. */
  const getTransferTracks = useCallback((): TransferSourceTrack[] => [...transferTracksRef.current.values()], []);

  /** The host confirmed it holds this track; remember it in the browser backup. */
  const markTransferDelivered = useCallback((trackId: string) => {
    const entry = transferTracksRef.current.get(trackId);
    if (!entry) return;
    void entry.store.markDelivered?.().catch(() => {});
    if (entry.finished) transferTracksRef.current.delete(trackId);
    setTransferVersion((version) => version + 1);
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
    updateSources,
    cancelUpload,
    inputEndedVersion,
    transferVersion,
    getTransferTracks,
    markTransferDelivered,
  };
}
