interface ChunkWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}
interface ChunkFileHandle {
  createWritable(): Promise<ChunkWritable>;
  getFile(): Promise<Blob>;
}
export interface RecordingChunkDirectory {
  getFileHandle(name: string, options: { create: boolean }): Promise<ChunkFileHandle>;
  removeEntry?(name: string): Promise<void>;
}

/** Commit chunks separately so a failed write cannot invalidate earlier footage. */
export function createRecordingChunkStore(
  directory?: RecordingChunkDirectory,
  prefix = `track-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  onDiskFailure?: (error: unknown) => void
) {
  let pending = Promise.resolve();
  let diskAvailable = Boolean(directory);
  let discarded = false;
  let nextIndex = 0;
  const parts: Blob[] = [];
  const diskFiles: string[] = [];

  const append = (data: Blob) => {
    if (!data.size || discarded) return;
    const filename = `${prefix}-${String(nextIndex++).padStart(6, '0')}.part`;
    pending = pending.then(async () => {
      if (discarded) return;
      if (diskAvailable && directory) {
        let writable: ChunkWritable | undefined;
        try {
          const handle = await directory.getFileHandle(filename, { create: true });
          writable = await handle.createWritable();
          await writable.write(data);
          await writable.close();
          const committed = await handle.getFile();
          if (committed.size !== data.size) throw new Error('Incomplete recording chunk');
          parts.push(committed);
          diskFiles.push(filename);
          return;
        } catch (error) {
          // Keep this chunk and all later chunks in order in memory. Earlier
          // committed Files remain disk-backed and are included in the result.
          diskAvailable = false;
          try { await writable?.abort?.(); } catch { /* Already closed or failed. */ }
          try { await directory.removeEntry?.(filename); } catch { /* Best-effort failed-file cleanup. */ }
          try { onDiskFailure?.(error); } catch { /* Reporting must not interrupt capture. */ }
        }
      }
      parts.push(data);
    });
  };

  return {
    append,
    flush: () => pending,
    /** Committed bytes so far, in capture order; equal to a prefix of finish(). */
    async snapshot(mimeType: string): Promise<Blob> {
      await pending;
      return new Blob(parts, { type: mimeType });
    },
    async finish(mimeType: string): Promise<Blob> {
      await pending;
      return new Blob(parts, { type: mimeType });
    },
    async discard(): Promise<void> {
      discarded = true;
      await pending;
      parts.length = 0;
      for (const filename of diskFiles) {
        try { await directory?.removeEntry?.(filename); } catch { /* Best-effort cleanup. */ }
      }
      diskFiles.length = 0;
    },
  };
}
