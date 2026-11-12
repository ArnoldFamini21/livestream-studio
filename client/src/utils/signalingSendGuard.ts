/**
 * The studio server closes a signaling connection that sends a message above
 * its size cap, so no message may ever get there: the encoded size, in bytes
 * (not characters), is checked before anything is sent.
 */
import { SIGNALING_SAFE_MESSAGE_BYTES } from '@studio/shared';

const encoder = new TextEncoder();

/** UTF-8 size of a string in bytes (characters outside ASCII take 2 to 4 bytes). */
export function measureEncodedBytes(text: string): number {
  return encoder.encode(text).length;
}

export interface SignalingSendGuard {
  /** The JSON to send, or null when the message is above the limit (it must not be sent). */
  encode(message: { type: string }): string | null;
}

/**
 * `report` is called once per message type, the first time a message of that
 * type is refused.
 */
export function createSignalingSendGuard(options: {
  limitBytes?: number;
  report?: (type: string, bytes: number, limitBytes: number) => void;
} = {}): SignalingSendGuard {
  const limit = options.limitBytes ?? SIGNALING_SAFE_MESSAGE_BYTES;
  const reported = new Set<string>();
  return {
    encode(message) {
      const text = JSON.stringify(message);
      // Most messages are tiny: skip the byte count when even 3 bytes per code unit fits.
      const bytes = text.length * 3 <= limit ? 0 : measureEncodedBytes(text);
      if (bytes <= limit) return text;
      if (!reported.has(message.type)) {
        reported.add(message.type);
        options.report?.(message.type, bytes, limit);
      }
      return null;
    },
  };
}
