import type { VideoEncodingConfig } from 'mediabunny';

type VideoSources = Pick<typeof import('mediabunny'), 'VideoSample' | 'VideoSampleSource'>;
type MapFirstFrameTimestamp = (receivedAtSeconds: number) => number;

interface VideoTrackProcessor {
  new (options: { track: MediaStreamTrack; maxBufferSize: number }): {
    readable: ReadableStream<VideoFrame>;
  };
}

function getVideoTrackProcessor() {
  return (globalThis as typeof globalThis & { MediaStreamTrackProcessor?: VideoTrackProcessor }).MediaStreamTrackProcessor;
}

type FrameOrientation = { rotation?: 0 | 90 | 180 | 270; flip?: boolean };

/**
 * Retain one borrowed camera frame only for the pixel read. The frame handed
 * to the encoder is constructed from our buffer and cannot hold a camera slot.
 */
export function createRecordingOwnedVideoSource(
  track: MediaStreamTrack,
  encodingConfig: VideoEncodingConfig,
  { VideoSample, VideoSampleSource }: VideoSources,
) {
  const source = new VideoSampleSource({ ...encodingConfig, latencyMode: 'realtime' });
  let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  let capture: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let stopped = false;
  let paused = false;
  let lastSourceUs: number | null = null;
  let offsetUs: number | null = null;
  let pixels = new ArrayBuffer(0);
  let useRgbReadback = false;

  let rejectCapture!: (reason: unknown) => void;
  const errorPromise = new Promise<never>((_, reject) => { rejectCapture = reject; });

  const copyPixels = async (frame: VideoFrame, format?: 'RGBA') => {
    const options: VideoFrameCopyToOptions = format ? { format, colorSpace: 'srgb' } : {};
    const bytes = frame.allocationSize(options);
    if (pixels.byteLength < bytes) pixels = new ArrayBuffer(bytes);
    return await frame.copyTo(pixels, options);
  };

  async function readFrame(input: ReadableStreamDefaultReader<VideoFrame>, mapFirstFrame: MapFirstFrameTimestamp) {
    while (!stopped) {
      const { done, value: frame } = await input.read();
      if (done) return;
      let init: VideoFrameBufferInit;
      let orientation: FrameOrientation;

      try {
        if (stopped) return;
        const rawUs = frame.timestamp;
        if (paused) {
          // Remove only the explicit pause. Preserve all source frame intervals
          // while recording, including any real gaps.
          if (offsetUs !== null && lastSourceUs !== null) offsetUs -= rawUs - lastSourceUs;
          lastSourceUs = rawUs;
          continue;
        }
        offsetUs ??= Math.round(mapFirstFrame(performance.now() / 1000) * 1e6) - rawUs;
        lastSourceUs = rawUs;

        orientation = { rotation: (frame as VideoFrame & FrameOrientation).rotation, flip: (frame as VideoFrame & FrameOrientation).flip };
        const swapAxes = orientation.rotation === 90 || orientation.rotation === 270;
        const rect = frame.visibleRect;
        const { format, colorSpace, displayWidth, displayHeight, duration } = frame;
        let layout: PlaneLayout[] | undefined;
        if (!useRgbReadback && format) {
          try {
            layout = await copyPixels(frame);
          } catch {
            // GPU-backed frames can reject a native-plane read. WebCodecs
            // also allows an explicit RGB read of the same visible pixels.
            useRgbReadback = true;
          }
        }
        if (!layout) layout = await copyPixels(frame, 'RGBA');
        init = {
          timestamp: rawUs + offsetUs,
          ...(duration === null ? {} : { duration }),
          format: useRgbReadback || !format ? 'RGBA' : format,
          codedWidth: rect?.width ?? frame.codedWidth,
          codedHeight: rect?.height ?? frame.codedHeight,
          displayWidth: swapAxes ? displayHeight : displayWidth,
          displayHeight: swapAxes ? displayWidth : displayHeight,
          colorSpace: useRgbReadback || !format ? undefined : colorSpace.toJSON(),
          layout,
        };
      } finally {
        frame.close();
      }

      // The constructor copies the bytes. The staging buffer can be reused
      // even while the codec retains the new frame internally.
      const ownedFrame = new VideoFrame(pixels, init);
      try {
        const sample = new VideoSample(ownedFrame, orientation);
        try {
          await source.add(sample);
        } finally {
          sample.close();
        }
      } finally {
        ownedFrame.close();
      }
    }
  }

  return {
    source,
    errorPromise,
    start(mapFirstFrame: MapFirstFrameTimestamp = () => 0): void {
      if (capture || stopped) return;
      try {
        const Processor = getVideoTrackProcessor();
        if (!Processor) throw new Error('The browser cannot read video tracks for recording.');
        const input = new Processor({ track, maxBufferSize: 1 }).readable.getReader();
        reader = input;
        capture = readFrame(input, mapFirstFrame).catch(rejectCapture).finally(() => {
          reader = null;
          input.releaseLock();
        });
      } catch (error) {
        rejectCapture(error);
      }
    },
    pause(): void {
      paused = true;
    },
    resume(): void {
      paused = false;
    },
    stop(): Promise<void> {
      stopped = true;
      return stopping ??= (async () => {
        await reader?.cancel().catch(rejectCapture);
        await capture;
      })();
    },
  };
}
