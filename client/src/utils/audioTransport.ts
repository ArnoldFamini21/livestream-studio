/**
 * How the microphone travels over a mesh peer connection.
 *
 * Voice (default): Opus with RED redundancy first when the browser offers it
 * (each packet also carries the previous one, so a lost packet on a long
 * Philippines-US link does not become a click), and the audio sender marked
 * high priority so congestion squeezes video before speech.
 *
 * Music mode: stereo Opus at up to 128 kbps. Opus parameters live in the SDP
 * fmtp line. They describe what the author of a description wants to
 * receive, and a sender's encoder follows the parameters in the other side's
 * description. So both are rewritten: our own description, so the other side
 * knows we accept and send stereo, and the other side's description before we
 * apply it, so our encoder sends stereo at the music bitrate.
 */

export const MUSIC_MODE_OPUS_PARAMETERS: ReadonlyArray<readonly [string, string]> = [
  ['stereo', '1'],
  ['sprop-stereo', '1'],
  ['maxaveragebitrate', '128000'],
];

const RTPMAP_OPUS = /^a=rtpmap:(\d+) opus\/48000(?:\/\d+)?$/i;

function setFmtpParameters(existing: string, parameters: ReadonlyArray<readonly [string, string]>): string {
  const entries = existing
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf('=');
      return index < 0 ? [part, ''] as [string, string] : [part.slice(0, index).trim(), part.slice(index + 1).trim()] as [string, string];
    });
  for (const [key, value] of parameters) {
    const found = entries.find(([name]) => name.toLowerCase() === key);
    if (found) found[1] = value;
    else entries.push([key, value]);
  }
  return entries.map(([name, value]) => (value === '' ? name : `${name}=${value}`)).join(';');
}

/** Rewrite every Opus fmtp line (adding one where missing) in the audio sections of an SDP. */
export function setOpusMusicParameters(sdp: string): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const trailingEmpty = lines.length > 0 && lines[lines.length - 1] === '';
  if (trailingEmpty) lines.pop();

  const output: string[] = [];
  let section: string[] = [];
  const flush = () => {
    if (section.length === 0) return;
    if (!/^m=audio\b/.test(section[0])) {
      output.push(...section);
      section = [];
      return;
    }
    // Payload types are per media section, so look them up section by section.
    const opusTypes = new Set<string>();
    for (const line of section) {
      const match = RTPMAP_OPUS.exec(line);
      if (match) opusTypes.add(match[1]);
    }
    const withFmtp = new Set<string>();
    const rewritten = section.map((line) => {
      const match = /^a=fmtp:(\d+) ?(.*)$/.exec(line);
      if (!match || !opusTypes.has(match[1])) return line;
      withFmtp.add(match[1]);
      return `a=fmtp:${match[1]} ${setFmtpParameters(match[2], MUSIC_MODE_OPUS_PARAMETERS)}`;
    });
    for (const payloadType of opusTypes) {
      if (withFmtp.has(payloadType)) continue;
      const rtpmapIndex = rewritten.findIndex((line) => RTPMAP_OPUS.exec(line)?.[1] === payloadType);
      rewritten.splice(rtpmapIndex + 1, 0, `a=fmtp:${payloadType} ${setFmtpParameters('', MUSIC_MODE_OPUS_PARAMETERS)}`);
    }
    output.push(...rewritten);
    section = [];
  };
  for (const line of lines) {
    if (line.startsWith('m=')) flush();
    section.push(line);
  }
  flush();
  return output.join(eol) + (trailingEmpty ? eol : '');
}

/** The description to apply (ours or theirs): unchanged for voice, stereo Opus for music. */
export function transformDescriptionForMusicMode(
  description: RTCSessionDescriptionInit,
  musicMode: boolean
): RTCSessionDescriptionInit {
  if (!musicMode || !description.sdp || (description.type !== 'offer' && description.type !== 'answer' && description.type !== 'pranswer')) {
    return description;
  }
  return { type: description.type, sdp: setOpusMusicParameters(description.sdp) };
}

interface CodecLike { mimeType: string }

/**
 * Voice: RED first, then everything else in the browser's order. Returns
 * null when there is no RED to prefer. Music: RED would double the 128 kbps
 * stream, so Opus first and no RED.
 */
export function orderAudioCodecs<T extends CodecLike>(codecs: readonly T[], musicMode: boolean): T[] | null {
  const isRed = (codec: T) => codec.mimeType.toLowerCase() === 'audio/red';
  if (!musicMode) {
    const red = codecs.filter(isRed);
    if (red.length === 0) return null;
    return [...red, ...codecs.filter((codec) => !isRed(codec))];
  }
  const withoutRed = codecs.filter((codec) => !isRed(codec));
  if (withoutRed.length === codecs.length) return null;
  return withoutRed;
}

interface TransceiverLike {
  receiver: { track: { kind: string } | null };
  stopped?: boolean;
  currentDirection?: RTCRtpTransceiverDirection | null;
  setCodecPreferences?: (codecs: RTCRtpCodec[]) => void;
}

interface PeerConnectionLike {
  getTransceivers?: () => TransceiverLike[];
}

type GetCapabilities = (kind: string) => { codecs: RTCRtpCodec[] } | null;

function defaultGetCapabilities(): GetCapabilities | null {
  if (typeof RTCRtpReceiver === 'undefined' || typeof RTCRtpReceiver.getCapabilities !== 'function') return null;
  return (kind) => RTCRtpReceiver.getCapabilities(kind);
}

/**
 * Apply the audio codec order to every audio transceiver. Called before each
 * createOffer/createAnswer so transceivers made by a remote offer are covered.
 */
export function applyAudioCodecPreferences(
  pc: PeerConnectionLike,
  musicMode: boolean,
  getCapabilities: GetCapabilities | null = defaultGetCapabilities()
): number {
  if (!getCapabilities || typeof pc.getTransceivers !== 'function') return 0;
  const codecs = getCapabilities('audio')?.codecs;
  if (!codecs || codecs.length === 0) return 0;
  const ordered = orderAudioCodecs(codecs, musicMode);
  let applied = 0;
  for (const transceiver of pc.getTransceivers()) {
    if (transceiver.receiver.track?.kind !== 'audio') continue;
    if (transceiver.stopped || transceiver.currentDirection === 'stopped') continue;
    if (typeof transceiver.setCodecPreferences !== 'function') continue;
    try {
      // An empty list restores the browser's default order.
      transceiver.setCodecPreferences(ordered ?? []);
      applied++;
    } catch {
      // A codec list the browser rejects keeps its defaults.
    }
  }
  return applied;
}

interface SenderLike {
  getParameters?: () => RTCRtpSendParameters;
  setParameters?: (parameters: RTCRtpSendParameters) => Promise<void>;
}

/** Mark an audio sender high priority (DSCP and bandwidth share); true when it was applied. */
export async function applyAudioSenderPriority(sender: SenderLike | null | undefined): Promise<boolean> {
  if (!sender || typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return false;
  const parameters = sender.getParameters();
  if (!parameters.encodings || parameters.encodings.length === 0) return false;
  if (parameters.encodings.every((encoding) => encoding.priority === 'high' && encoding.networkPriority === 'high')) return true;
  parameters.encodings = parameters.encodings.map((encoding) => ({ ...encoding, priority: 'high', networkPriority: 'high' }));
  try {
    await sender.setParameters(parameters);
    return true;
  } catch {
    return false;
  }
}
