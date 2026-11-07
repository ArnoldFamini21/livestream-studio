/**
 * The program return: a low-bitrate copy of the program that the stage owner
 * (the host, or the first co-host when no host is in) sends to guests over
 * the mesh, so backstage guests can watch and hear the show and on-stage
 * guests can see a clip the host plays.
 *
 * It travels on its own sendonly transceivers beside the camera and screen,
 * in a MediaStream whose id is announced over signaling first, so receivers
 * never take it for a participant camera or a screen share. It costs uplink
 * on a Philippines-US link, so it goes only to the peers who need it.
 */
import type { Participant, StageContentPayload } from '@studio/shared';
import { getStageOwnerId, hasStudioCapability } from '@studio/shared';
import { sendScreenOnConnection, stopScreenOnConnection } from './screenTransceiver.ts';

export const PROGRAM_RETURN_WIDTH = 640;
export const PROGRAM_RETURN_HEIGHT = 360;
export const PROGRAM_RETURN_FPS = 15;

/** The return keeps the program's orientation: 640x360 for 16:9, 360x640 for 9:16. */
export function getProgramReturnSize(sourceWidth: number, sourceHeight: number): { width: number; height: number } {
  return sourceHeight > sourceWidth
    ? { width: PROGRAM_RETURN_HEIGHT, height: PROGRAM_RETURN_WIDTH }
    : { width: PROGRAM_RETURN_WIDTH, height: PROGRAM_RETURN_HEIGHT };
}
/** Video ceiling per receiving peer, in bits per second. */
export const PROGRAM_RETURN_MAX_BITRATE = 500_000;

export interface ProgramReturnRoute {
  video: boolean;
  audio: boolean;
}

export const NO_PROGRAM_RETURN: ProgramReturnRoute = Object.freeze({ video: false, audio: false });

export interface ProgramReturnRoutingContext {
  /**
   * Media is on the program that guests cannot see as a mirrored picture (a
   * video clip, a document, a slide whose picture did not upload).
   */
  stageNeedsVideo: boolean;
}

type RouteTarget = Pick<Participant, 'role' | 'status' | 'capabilities'> | null | undefined;

/**
 * What the program return sends to one peer:
 * - waiting (green room) guests never get it, for privacy;
 * - peers whose client did not advertise 'program-return' (a tab loaded
 *   before it existed, or anyone while the server is older) never get it:
 *   they would show it as the host's screen share and play its audio;
 * - hosts and co-hosts run their own compositor preview, so they never need it;
 * - backstage guests get video and the program audio;
 * - on-stage guests get the video only while staged media has no mirrored
 *   picture. They already hear the studio live, so no program audio (it
 *   would echo their own voice back to them).
 */
export function getProgramReturnRoute(target: RouteTarget, context: ProgramReturnRoutingContext): ProgramReturnRoute {
  if (!target) return NO_PROGRAM_RETURN;
  if (target.status === 'green-room') return NO_PROGRAM_RETURN;
  if (!hasStudioCapability(target, 'program-return')) return NO_PROGRAM_RETURN;
  if (target.role === 'host' || target.role === 'co-host') return NO_PROGRAM_RETURN;
  if (target.status === 'backstage') return { video: true, audio: true };
  if (target.status === 'on-stage' && context.stageNeedsVideo) return { video: true, audio: false };
  return NO_PROGRAM_RETURN;
}

/**
 * Who the program return audio carries: on-stage guests only. Hosts and
 * co-hosts reach backstage guests directly over the mesh (canExchangeStudioMedia
 * sends every operator's mic and screen sound to the backstage), so mixing
 * them in again would play each operator twice, the return copy 100-300 ms
 * late: an echo. Same Map back when nobody needs filtering.
 */
export function getProgramReturnAudioParticipants<TParticipant extends Pick<Participant, 'role'>>(
  participants: Map<string, TParticipant>,
): Map<string, TParticipant> {
  let filtered: Map<string, TParticipant> | null = null;
  for (const [id, participant] of participants) {
    if (participant.role !== 'host' && participant.role !== 'co-host') continue;
    filtered ??= new Map(participants);
    filtered.delete(id);
  }
  return filtered ?? participants;
}

/** Whether anyone needs the feed now (it is only built, and the compositor only runs for it, then). */
export function getProgramReturnDemand(
  participants: Iterable<[string, RouteTarget]>,
  selfId: string | null | undefined,
  context: ProgramReturnRoutingContext,
): ProgramReturnRoute {
  let video = false;
  let audio = false;
  for (const [id, participant] of participants) {
    if (id === selfId) continue;
    const route = getProgramReturnRoute(participant, context);
    video ||= route.video;
    audio ||= route.audio;
    if (video && audio) break;
  }
  return { video, audio };
}

/** Only the stage owner publishes the program return and mirrors the stage. */
export function isStageOwner(
  self: Pick<Participant, 'id' | 'role' | 'status' | 'joinedAt'> | null | undefined,
  participants: Iterable<Pick<Participant, 'id' | 'role' | 'status' | 'joinedAt'>>,
): boolean {
  if (!self || (self.role !== 'host' && self.role !== 'co-host')) return false;
  const everyone = [self, ...Array.from(participants).filter((participant) => participant.id !== self.id)];
  return getStageOwnerId(everyone) === self.id;
}

/** A staged item guests see only as a file name: the program return shows it instead. */
export function stageContentNeedsProgramVideo(content: StageContentPayload | null | undefined): boolean {
  return Boolean(content?.media && !content.media.imageId && !content.contentHidden);
}

/** "LIVE" while the studio is on air, "Preview" before and after. */
export function getProgramReturnLabel(live: boolean): 'LIVE' | 'Preview' {
  return live ? 'LIVE' : 'Preview';
}

/** The program return to show: the stage owner's, or whichever operator's arrived. */
export function pickProgramReturnStream<TStream>(
  streams: ReadonlyMap<string, TStream>,
  ownerId: string | null | undefined,
): TStream | null {
  if (ownerId && streams.has(ownerId)) return streams.get(ownerId) ?? null;
  for (const stream of streams.values()) return stream;
  return null;
}

/** Cap the encoder at about 500 kbps and 15 fps; the 640x360 source is sent unscaled. */
export function applyProgramReturnEncoding(parameters: RTCRtpSendParameters): RTCRtpSendParameters {
  const encodings = parameters.encodings && parameters.encodings.length > 0 ? parameters.encodings : [{}];
  return {
    ...parameters,
    encodings: encodings.map((encoding) => ({
      ...encoding,
      maxBitrate: PROGRAM_RETURN_MAX_BITRATE,
      maxFramerate: PROGRAM_RETURN_FPS,
      scaleResolutionDownBy: 1,
    })),
    degradationPreference: 'balanced',
  };
}

export interface ProgramReturnSource {
  stream: MediaStream;
  video: MediaStreamTrack | null;
  audio: MediaStreamTrack | null;
}

function isLive(track: MediaStreamTrack | null | undefined): track is MediaStreamTrack {
  return Boolean(track) && track!.readyState === 'live';
}

function isStopped(transceiver: RTCRtpTransceiver): boolean {
  return transceiver.currentDirection === 'stopped' || transceiver.direction === 'stopped';
}

/**
 * Keeps one peer connection's program return transceivers in step with the
 * feed and the route. Calls are serialized per peer, so a burst of updates
 * never adds a second transceiver. The stream id is announced to the peer
 * before the first track is attached: the announcement and the offer go out
 * on the same signaling socket, so it arrives first.
 */
export class ProgramReturnPeerSender {
  private video: RTCRtpTransceiver | null = null;
  private audio: RTCRtpTransceiver | null = null;
  private announcedStreamId: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly pc: RTCPeerConnection,
    private readonly announce: (streamId: string) => void,
  ) {}

  get videoTransceiver(): RTCRtpTransceiver | null {
    return this.video;
  }

  get audioTransceiver(): RTCRtpTransceiver | null {
    return this.audio;
  }

  /** True while a program return track is attached to this peer. */
  get sending(): boolean {
    return Boolean(this.video?.sender.track || this.audio?.sender.track);
  }

  sync(source: ProgramReturnSource | null, route: ProgramReturnRoute): Promise<void> {
    this.queue = this.queue
      .then(() => this.apply(source, route))
      .catch((error) => {
        console.warn('Could not update the program return for a peer:', error);
      });
    return this.queue;
  }

  dispose(): void {
    this.disposed = true;
  }

  private async apply(source: ProgramReturnSource | null, route: ProgramReturnRoute): Promise<void> {
    if (this.disposed || this.pc.signalingState === 'closed') return;
    const videoTrack = route.video && source && isLive(source.video) ? source.video : null;
    // Audio only goes along with the picture: a monitor with no picture is not a monitor.
    const audioTrack = videoTrack && route.audio && source && isLive(source.audio) ? source.audio : null;

    if (videoTrack && source && this.announcedStreamId !== source.stream.id) {
      this.announce(source.stream.id);
      this.announcedStreamId = source.stream.id;
    }

    this.video = await this.attach(this.video, videoTrack, source?.stream ?? null);
    if (videoTrack && this.video) await this.capVideo(this.video);
    this.audio = await this.attach(this.audio, audioTrack, source?.stream ?? null);
  }

  private async attach(
    current: RTCRtpTransceiver | null,
    track: MediaStreamTrack | null,
    stream: MediaStream | null,
  ): Promise<RTCRtpTransceiver | null> {
    if (current && isStopped(current)) current = null;
    if (!track || !stream) {
      if (current?.sender.track) await stopScreenOnConnection(current);
      return current;
    }
    if (current && current.sender.track === track && current.direction === 'sendonly') return current;
    if (current) return sendScreenOnConnection(this.pc, current, track, stream);
    // A new transceiver starts capped, so the first frames never burst past the ceiling.
    return this.pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [stream],
      ...(track.kind === 'video'
        ? { sendEncodings: [{ maxBitrate: PROGRAM_RETURN_MAX_BITRATE, maxFramerate: PROGRAM_RETURN_FPS }] }
        : {}),
    });
  }

  private async capVideo(transceiver: RTCRtpTransceiver): Promise<void> {
    const sender = transceiver.sender;
    if (typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return;
    const parameters = sender.getParameters();
    // Encodings appear once negotiated; the connection-state handler retries then.
    if (!parameters.encodings || parameters.encodings.length === 0) return;
    const current = parameters.encodings[0];
    if (current?.maxBitrate === PROGRAM_RETURN_MAX_BITRATE && current.maxFramerate === PROGRAM_RETURN_FPS) return;
    try {
      await sender.setParameters(applyProgramReturnEncoding(parameters));
    } catch (error) {
      console.warn('Could not cap the program return bitrate:', error);
    }
  }

  /** Re-apply the bitrate cap (after negotiation created the encodings). */
  refreshLimits(): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.video?.sender.track) await this.capVideo(this.video);
    }).catch(() => {});
    return this.queue;
  }
}
