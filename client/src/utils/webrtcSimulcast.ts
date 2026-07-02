export interface SimulcastVideoProfile {
  width?: number;
  height?: number;
  frameRate?: number;
}

export interface PeerConnectionLike {
  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender;
  addTransceiver?: (
    trackOrKind: MediaStreamTrack | string,
    init?: RTCRtpTransceiverInit
  ) => RTCRtpTransceiver;
}

function readTrackProfile(track: MediaStreamTrack): SimulcastVideoProfile {
  try {
    return typeof track.getSettings === 'function' ? track.getSettings() : {};
  } catch {
    return {};
  }
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function createEncoding(
  rid: string,
  scaleResolutionDownBy: number,
  maxBitrate: number,
  maxFramerate: number
): RTCRtpEncodingParameters {
  return {
    rid,
    scaleResolutionDownBy,
    maxBitrate,
    maxFramerate,
  };
}

export function buildVideoSimulcastEncodings(
  profile: SimulcastVideoProfile
): RTCRtpEncodingParameters[] {
  const width = boundedNumber(profile.width, 1920, 160, 3840);
  const height = boundedNumber(profile.height, 1080, 120, 2160);
  const frameRate = boundedNumber(profile.frameRate, 30, 1, 60);
  const longEdge = Math.max(width, height);

  if (longEdge >= 3000) {
    return [
      createEncoding('h', 1, 6_000_000, frameRate),
      createEncoding('m', 2, 2_500_000, Math.min(frameRate, 30)),
      createEncoding('l', 4, 650_000, Math.min(frameRate, 24)),
    ];
  }

  if (longEdge >= 1600) {
    return [
      createEncoding('h', 1, 2_800_000, frameRate),
      createEncoding('m', 2, 1_200_000, Math.min(frameRate, 30)),
      createEncoding('l', 4, 350_000, Math.min(frameRate, 20)),
    ];
  }

  if (longEdge >= 960) {
    return [
      createEncoding('h', 1, 1_600_000, frameRate),
      createEncoding('l', 2, 450_000, Math.min(frameRate, 24)),
    ];
  }

  return [];
}

export function buildVideoSimulcastEncodingsForTrack(track: MediaStreamTrack): RTCRtpEncodingParameters[] {
  if (track.kind !== 'video' || track.readyState !== 'live') return [];
  return buildVideoSimulcastEncodings(readTrackProfile(track));
}

export function addTrackWithOptionalSimulcast(
  connection: PeerConnectionLike,
  track: MediaStreamTrack,
  stream: MediaStream
): RTCRtpSender {
  const encodings = buildVideoSimulcastEncodingsForTrack(track);
  if (encodings.length > 0 && typeof connection.addTransceiver === 'function') {
    try {
      return connection.addTransceiver(track, {
        direction: 'sendrecv',
        streams: [stream],
        sendEncodings: encodings,
      }).sender;
    } catch (err) {
      console.warn('Video simulcast sender setup failed; falling back to addTrack:', err);
    }
  }

  return connection.addTrack(track, stream);
}

export async function refreshSenderVideoEncodingParameters(
  sender: RTCRtpSender,
  track: MediaStreamTrack
): Promise<boolean> {
  if (track.kind !== 'video' || typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') {
    return false;
  }

  const nextEncodings = buildVideoSimulcastEncodingsForTrack(track);
  if (nextEncodings.length === 0) return false;

  const parameters = sender.getParameters();
  if (!parameters.encodings || parameters.encodings.length === 0) return false;

  parameters.encodings = parameters.encodings.map((encoding, index) => {
    const next = nextEncodings[Math.min(index, nextEncodings.length - 1)];
    return {
      ...encoding,
      scaleResolutionDownBy: next.scaleResolutionDownBy,
      maxBitrate: next.maxBitrate,
      maxFramerate: next.maxFramerate,
    };
  });

  await sender.setParameters(parameters);
  return true;
}
