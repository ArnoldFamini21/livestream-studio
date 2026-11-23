import { drawClipCaption, type ClipCaptionCue, type ClipCaptionStyle } from './clipCaptions.ts';
import type { EditSegment } from './editListExport.ts';
import {
  KeepRangeMapper,
  applyEdgeFades,
  chooseRenderVideoBitrate,
  computeRenderProgress,
  splitAudioBlock,
  toEvenDimension,
  type RenderProgress,
} from './cleanedRenderPlan.ts';
import { MAX_IN_MEMORY_RENDER_BYTES, type RenderOutputFile } from './renderOutputFolder.ts';
import { MIX_SAMPLE_RATE, mixRecordingAudio, type MixPictureRun, type RecordingMix } from './recordingTrackMix.ts';

/**
 * Renders a cleaned track or multitrack edit to MP4 entirely in this browser.
 *
 *   WebM/Matroska (BlobSource reads the file in pieces, so a long recording
 *   on the SSD is never loaded into memory)
 *   -> VideoDecoder / AudioDecoder (WebCodecs, via mediabunny)
 *   -> frames outside the kept ranges are dropped, kept ones re-timed
 *   -> VideoEncoder H.264 (hardware preferred; HEVC/VP9/AV1 if H.264 is
 *      unavailable) and AudioEncoder AAC (Opus if AAC is unavailable)
 *   -> MP4, streamed to the output file as it is produced.
 *
 * mediabunny (MPL-2.0, pure TypeScript, no workers or wasm) is imported only
 * when a render starts, so it never weighs on the studio page.
 */

export class RenderCancelledError extends Error {
  constructor() {
    super('The render was cancelled.');
    this.name = 'RenderCancelledError';
  }
}

export interface CleanedRenderInput {
  blob: Blob;
  label: string;
  /** Kept pieces of this track (seconds from its first frame), in order. */
  segments: EditSegment[];
  output: RenderOutputFile;
  captions?: { cues: ClipCaptionCue[]; style: ClipCaptionStyle };
  /** Optional aligned isolated tracks replace the picture file's audio. */
  audioMix?: RecordingMix;
  /** Kept video ranges by camera, starting with the same picture as blob. */
  pictureRuns?: MixPictureRun[];
  signal?: AbortSignal;
  onProgress?: (progress: RenderProgress) => void;
}

export interface CleanedRenderResult {
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  durationSeconds: number;
  /** Set when the output was buffered in memory. */
  buffer: ArrayBuffer | null;
}

const VIDEO_CODEC_PREFERENCE = ['avc', 'hevc', 'vp9', 'av1'] as const;
const AUDIO_CODEC_PREFERENCE = ['aac', 'opus'] as const;
const AUDIO_BITRATE = 192_000;

function throwIfCancelled(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new RenderCancelledError();
}

export async function renderCleanedTrack(input: CleanedRenderInput): Promise<CleanedRenderResult> {
  const { segments } = input;
  if (segments.length === 0) throw new Error(`Nothing of ${input.label} is kept by the cleanup.`);
  throwIfCancelled(input.signal);
  if (!input.output.writable && input.blob.size > MAX_IN_MEMORY_RENDER_BYTES) {
    throw new Error('This browser cannot write the render to disk, and the recording is too large to render in memory. Use Chrome or Edge, or the edit list.');
  }
  // One failing pipeline (video or audio) stops the other too.
  const internal = new AbortController();
  const onAbort = () => internal.abort();
  input.signal?.addEventListener('abort', onAbort, { once: true });
  const signal = internal.signal;

  const mb = await import('mediabunny');
  const source = new mb.BlobSource(input.blob);
  const media = new mb.Input({ source, formats: mb.ALL_FORMATS });
  const target = input.output.writable
    ? new mb.StreamTarget(input.output.writable as WritableStream<{ type: 'write'; data: Uint8Array<ArrayBuffer>; position: number }>, { chunked: true })
    : new mb.BufferTarget();
  const output = new mb.Output({
    // Metadata at the end needs no buffering; in memory, Fast Start is free.
    format: new mb.Mp4OutputFormat({ fastStart: input.output.writable ? false : 'in-memory' }),
    target,
  });
  let started = false;

  try {
    const videoTrack = await media.getPrimaryVideoTrack();
    const audioTrack = input.audioMix ? null : await media.getPrimaryAudioTrack();
    const decodableVideo = videoTrack && await videoTrack.canDecode() ? videoTrack : null;
    const decodableAudio = audioTrack && await audioTrack.canDecode() ? audioTrack : null;
    if (videoTrack && !decodableVideo) {
      throw new Error(`This browser cannot decode the ${videoTrack.codec || 'video'} picture of ${input.label}.`);
    }
    if (input.audioMix && !decodableVideo) throw new Error(`${input.label} has no decodable picture. Choose another track.`);
    if (!decodableVideo && !decodableAudio) throw new Error(`${input.label} has no picture or sound this browser can decode.`);

    const firstTimestamp = await media.getFirstTimestamp().catch(() => 0);
    const lastSegment = segments[segments.length - 1];
    const totalSeconds = input.audioMix?.durationSeconds ?? lastSegment.recordStart + (lastSegment.sourceEnd - lastSegment.sourceStart);
    const readStart = firstTimestamp + segments[0].sourceStart;
    const readEnd = firstTimestamp + lastSegment.sourceEnd;

    let videoSource: InstanceType<typeof mb.VideoSampleSource> | null = null;
    let videoCodec: string | null = null;
    let captionContext: CanvasRenderingContext2D | null = null;
    if (decodableVideo) {
      const displayWidth = await decodableVideo.getDisplayWidth();
      const displayHeight = await decodableVideo.getDisplayHeight();
      const width = toEvenDimension(displayWidth);
      const height = toEvenDimension(displayHeight);
      const bitrate = chooseRenderVideoBitrate(width, height);
      videoCodec = await mb.getFirstEncodableVideoCodec([...VIDEO_CODEC_PREFERENCE], { width, height, bitrate });
      if (!videoCodec) throw new Error('This browser has no video encoder for MP4 (H.264, HEVC, VP9 or AV1).');
      videoSource = new mb.VideoSampleSource({
        codec: videoCodec as (typeof VIDEO_CODEC_PREFERENCE)[number],
        bitrate,
        keyFrameInterval: 2,
        // A camera that changed resolution mid-take is letterboxed, not rejected.
        sizeChangeBehavior: 'contain',
        ...(width !== displayWidth || height !== displayHeight ? { transform: { width, height, fit: 'contain' as const } } : {}),
      });
      if (input.pictureRuns || input.captions?.cues.length) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        captionContext = canvas.getContext('2d', { alpha: false });
        if (!captionContext) throw new Error('This browser cannot compose the picture for video export.');
      }
      output.addVideoTrack(videoSource);
    }

    let audioSource: InstanceType<typeof mb.AudioSampleSource> | null = null;
    let audioCodec: string | null = null;
    if (input.audioMix || decodableAudio) {
      const numberOfChannels = decodableAudio ? await decodableAudio.getNumberOfChannels() : 1;
      const sampleRate = decodableAudio ? await decodableAudio.getSampleRate() : MIX_SAMPLE_RATE;
      audioCodec = await mb.getFirstEncodableAudioCodec([...AUDIO_CODEC_PREFERENCE], { numberOfChannels, sampleRate, bitrate: AUDIO_BITRATE });
      if (audioCodec) {
        audioSource = new mb.AudioSampleSource({ codec: audioCodec as (typeof AUDIO_CODEC_PREFERENCE)[number], bitrate: AUDIO_BITRATE });
        output.addAudioTrack(audioSource);
      } else if (input.audioMix || !videoSource) {
        throw new Error('This browser has no audio encoder for MP4 (AAC or Opus).');
      }
    }

    await output.start();
    started = true;
    throwIfCancelled(signal);

    let videoSeconds = 0;
    let audioSeconds = 0;
    const report = () => input.onProgress?.(computeRenderProgress(
      videoSource && audioSource ? Math.min(videoSeconds, audioSeconds) : (videoSource ? videoSeconds : audioSeconds),
      totalSeconds,
    ));

    const renderVideo = async () => {
      if (!videoSource || !decodableVideo) return;
      const runs = input.pictureRuns ?? [{ picture: { blob: input.blob, label: input.label }, segments }];
      const captions = input.captions;
      let cueIndex = 0;
      for (const run of runs) {
        throwIfCancelled(signal);
        const camera = run.picture.blob === input.blob ? media : new mb.Input({ source: new mb.BlobSource(run.picture.blob), formats: mb.ALL_FORMATS });
        try {
          const track = camera === media ? decodableVideo : await camera.getPrimaryVideoTrack();
          if (!track || (camera !== media && !(await track.canDecode()))) {
            throw new Error(`${run.picture.label} has no decodable picture. Choose another track.`);
          }
          const origin = camera === media ? firstTimestamp : await camera.getFirstTimestamp().catch(() => 0);
          const first = run.segments[0].sourceStart;
          const last = run.segments[run.segments.length - 1].sourceEnd;
          if (input.pictureRuns) {
            // Capture and transcript endpoints may differ by one recorded frame.
            const tolerance = 0.12;
            const pictureStart = await track.getFirstTimestamp() - origin;
            const pictureEnd = await track.computeDuration() - origin;
            if (first < pictureStart - tolerance || last > pictureEnd + tolerance) {
              throw new Error(`${run.picture.label} does not cover its assigned camera range. Adjust the camera cuts or choose another track.`);
            }
          }
          const sink = new mb.VideoSampleSink(track);
          const mapper = new KeepRangeMapper(run.segments);
          let wroteVideo = false;
          for await (const sample of sink.samples(origin + Math.max(0, first), origin + last)) {
            try {
              throwIfCancelled(signal);
              const sourceTime = sample.timestamp - origin;
              const outputTime = mapper.map(sourceTime);
              if (outputTime === null) {
                if (mapper.done) break;
                continue;
              }
              if (captionContext) {
                const { canvas } = captionContext;
                captionContext.clearRect(0, 0, canvas.width, canvas.height);
                sample.drawWithFit(captionContext, { fit: 'contain' });
                if (captions) {
                  while (captions.cues[cueIndex]?.end <= outputTime) cueIndex += 1;
                  const cue = captions.cues[cueIndex];
                  if (cue && cue.start <= outputTime) {
                    drawClipCaption(captionContext, [cue], outputTime, captions.style, canvas.width, canvas.height);
                  }
                }
                const duration = input.pictureRuns ? mapper.clipDuration(sourceTime, sample.duration || 1 / 30) : sample.duration;
                const frame = new mb.VideoSample(canvas, { timestamp: outputTime, duration });
                try {
                  await videoSource.add(frame);
                } finally {
                  frame.close();
                }
              } else {
                sample.setTimestamp(outputTime);
                await videoSource.add(sample);
              }
              wroteVideo = true;
              videoSeconds = outputTime;
              report();
            } finally {
              sample.close();
            }
          }
          if (input.audioMix && !wroteVideo) throw new Error(`${run.picture.label} has no footage in its edited range. Choose another track.`);
        } finally {
          if (camera !== media) camera.dispose();
        }
      }
      videoSeconds = totalSeconds;
      videoSource.close();
    };

    const renderAudio = async () => {
      if (!audioSource) return;
      if (input.audioMix) {
        for await (const { data, timestamp } of mixRecordingAudio(input.audioMix, signal)) {
          throwIfCancelled(signal);
          const sample = new mb.AudioSample({
            data, format: 'f32-planar', numberOfChannels: 1, sampleRate: MIX_SAMPLE_RATE, timestamp,
          });
          try {
            await audioSource.add(sample);
            audioSeconds = timestamp + sample.duration;
            report();
          } finally {
            sample.close();
          }
        }
        audioSeconds = totalSeconds;
        audioSource.close();
        return;
      }
      if (!decodableAudio) return;
      const sink = new mb.AudioSampleSink(decodableAudio);
      for await (const sample of sink.samples(readStart, readEnd)) {
        try {
          throwIfCancelled(signal);
          const start = sample.timestamp - firstTimestamp;
          if (start >= lastSegment.sourceEnd) break;
          const spans = splitAudioBlock(segments, start, sample.numberOfFrames, sample.sampleRate);
          for (const span of spans) {
            let piece = sample.trim(span.startFrame, span.endFrame);
            if (span.fadeIn || span.fadeOut) {
              const faded = fadePiece(mb, piece, span.fadeIn, span.fadeOut);
              piece.close();
              piece = faded;
            }
            try {
              piece.setTimestamp(span.outputTimestamp);
              await audioSource.add(piece);
              audioSeconds = span.outputTimestamp + piece.duration;
            } finally {
              piece.close();
            }
          }
          report();
        } finally {
          sample.close();
        }
      }
      audioSeconds = totalSeconds;
      audioSource.close();
    };

    const stopOther = (error: unknown) => { internal.abort(); throw error; };
    await Promise.all([renderVideo().catch(stopOther), renderAudio().catch(stopOther)]);
    throwIfCancelled(signal);
    await output.finalize();
    report();
    return {
      hasVideo: Boolean(videoSource),
      hasAudio: Boolean(audioSource),
      videoCodec,
      audioCodec: audioSource ? audioCodec : null,
      durationSeconds: totalSeconds,
      buffer: target instanceof mb.BufferTarget ? target.buffer : null,
    };
  } catch (error) {
    if (started || output.state === 'pending') await output.cancel().catch(() => {});
    if (input.signal?.aborted) throw new RenderCancelledError();
    throw error;
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
    media.dispose();
  }
}

type Mediabunny = typeof import('mediabunny');
type MediabunnyAudioSample = InstanceType<Mediabunny['AudioSample']>;

function fadePiece(mb: Mediabunny, piece: MediabunnyAudioSample, fadeIn: boolean, fadeOut: boolean): MediabunnyAudioSample {
  const frames = piece.numberOfFrames;
  const planes = Array.from({ length: piece.numberOfChannels }, (_, planeIndex) => {
    const plane = new Float32Array(frames);
    piece.copyTo(plane, { planeIndex, format: 'f32-planar' });
    return plane;
  });
  applyEdgeFades(planes, piece.sampleRate, fadeIn, fadeOut);
  const data = new Float32Array(frames * planes.length);
  planes.forEach((plane, index) => data.set(plane, index * frames));
  return new mb.AudioSample({
    data,
    format: 'f32-planar',
    numberOfChannels: piece.numberOfChannels,
    sampleRate: piece.sampleRate,
    timestamp: piece.timestamp,
  });
}
