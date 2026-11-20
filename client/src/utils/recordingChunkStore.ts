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

/** Fixed-length view of readable recording bytes, with slices at absolute byte offsets. */
export interface RecordingByteSource {
  readonly size: number;
  slice(start: number, end: number): Blob;
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
  const parts: { blob: Blob; end: number }[] = [];
  const diskFiles: string[] = [];
  const committedBytes = () => parts.at(-1)?.end ?? 0;

  const commitPart = (blob: Blob) => {
    parts.push({ blob, end: committedBytes() + blob.size });
  };

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
          commitPart(committed);
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
      commitPart(data);
    });
  };

  return {
    append,
    flush: () => pending,
    /** Read committed ranges without waiting for pending writes or assembling the take. */
    readCommitted(): RecordingByteSource {
      const size = discarded ? 0 : committedBytes();
      return {
        size,
        slice(start, end) {
          const from = Math.max(0, start);
          const to = Math.min(size, end);
          if (from >= to) return new Blob();
          if (discarded) throw new DOMException('The recording was discarded.', 'NotReadableError');

          // Skip parts ending at or before the requested start, even on a long take.
          let low = 0;
          let high = parts.length;
          while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (parts[middle].end <= from) low = middle + 1;
            else high = middle;
          }

          const selected: Blob[] = [];
          for (let index = low; index < parts.length; index += 1) {
            const part = parts[index];
            const partStart = part.end - part.blob.size;
            if (partStart >= to) break;
            const localStart = Math.max(0, from - partStart);
            const localEnd = Math.min(part.blob.size, to - partStart);
            selected.push(localStart === 0 && localEnd === part.blob.size
              ? part.blob
              : part.blob.slice(localStart, localEnd));
          }
          return selected.length === 1 ? selected[0] : new Blob(selected);
        },
      };
    },
    /** Wait for the currently queued writes before taking a capture-order snapshot. */
    async snapshot(mimeType: string): Promise<Blob> {
      await pending;
      return new Blob(parts.map(part => part.blob), { type: mimeType });
    },
    async finish(mimeType: string): Promise<Blob> {
      await pending;
      return new Blob(parts.map(part => part.blob), { type: mimeType });
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
