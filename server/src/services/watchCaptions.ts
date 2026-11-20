import type { CaptionSegmentPayload, WatchCaptionCue, WatchCaptionSnapshot } from '@studio/shared';

const CAPTION_HISTORY_MS = 120_000;
const MAX_CUES = 96;

export const WATCH_CAPTIONS_OFF: WatchCaptionSnapshot = { enabled: false, language: 'en-US', cues: [] };

export class WatchCaptionBuffer {
  private cues = new Map<string, WatchCaptionCue>();
  private sequence = 0;
  private startedAt = '';
  private language = 'en-US';
  ownerId: string | null = null;

  configure(ownerId: string, enabled: boolean, language: string): void {
    if (!enabled || ownerId !== this.ownerId || language !== this.language) this.cues.clear();
    this.ownerId = enabled ? ownerId : null;
    this.language = language;
  }

  append(segment: CaptionSegmentPayload, broadcastStartedAt: string, now: number): void {
    if (!this.ownerId || !segment.final) return;
    this.useBroadcast(broadcastStartedAt);
    const key = segment.participantId + '/' + segment.segmentId;
    if (this.cues.has(key)) return;
    // Sender wall clocks can differ. Keep the duration, and anchor it to the
    // server's receipt time on the same UTC timeline as the HLS segments.
    const duration = Math.max(1_600, Math.min(8_000, segment.endMs - segment.startMs));
    this.cues.set(key, {
      id: String(++this.sequence),
      text: segment.text,
      speaker: segment.speakerName?.slice(0, 80),
      startMs: Math.max(Date.parse(broadcastStartedAt), now - duration),
      endMs: now + 600,
    });
    this.prune(now);
  }

  read(broadcastStartedAt: string, now: number): WatchCaptionSnapshot {
    this.useBroadcast(broadcastStartedAt);
    this.prune(now);
    return { enabled: Boolean(this.ownerId), language: this.language, cues: [...this.cues.values()] };
  }

  reset(): void {
    this.cues.clear();
    this.startedAt = '';
  }

  private useBroadcast(startedAt: string): void {
    if (startedAt === this.startedAt) return;
    this.cues.clear();
    this.startedAt = startedAt;
  }

  private prune(now: number): void {
    for (const [key, cue] of this.cues) {
      if (this.cues.size <= MAX_CUES && cue.endMs >= now - CAPTION_HISTORY_MS) break;
      this.cues.delete(key);
    }
  }
}
