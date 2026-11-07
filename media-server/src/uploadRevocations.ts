/**
 * Recording-upload tokens last hours so a long take can finish uploading. When
 * the host removes or bans someone, the signaling server tells the media server
 * (over the signed membership control channel) to stop accepting that person's
 * uploads: any token issued to them before that moment is refused.
 */

/** Kept a little longer than the longest recording-upload token (6 h). */
export const UPLOAD_REVOCATION_TTL_MS = 7 * 60 * 60 * 1000;

export class RecordingUploadRevocations {
  private readonly revokedAt = new Map<string, number>();

  constructor(private readonly ttlMs = UPLOAD_REVOCATION_TTL_MS) {}

  private key(roomId: string, participantId: string) {
    return `${roomId}\u0000${participantId}`;
  }

  revoke(roomId: string, participantId: string, atMs = Date.now()): void {
    this.sweep(atMs);
    const key = this.key(roomId, participantId);
    this.revokedAt.set(key, Math.max(this.revokedAt.get(key) ?? 0, atMs));
  }

  /**
   * Whether a token issued at `issuedAtMs` for this participant was revoked. A
   * token without an issue time predates revocation support and is refused once
   * its holder has been revoked.
   */
  isRevoked(roomId: string, participantId: string, issuedAtMs: number | undefined, nowMs = Date.now()): boolean {
    const key = this.key(roomId, participantId);
    const revokedAt = this.revokedAt.get(key);
    if (revokedAt === undefined) return false;
    if (nowMs - revokedAt > this.ttlMs) {
      this.revokedAt.delete(key);
      return false;
    }
    return issuedAtMs === undefined || !Number.isFinite(issuedAtMs) || issuedAtMs <= revokedAt;
  }

  sweep(nowMs = Date.now()): void {
    for (const [key, revokedAt] of this.revokedAt) {
      if (nowMs - revokedAt > this.ttlMs) this.revokedAt.delete(key);
    }
  }

  get size(): number {
    return this.revokedAt.size;
  }
}
