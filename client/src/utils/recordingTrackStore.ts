import { createRecoverableRecordingStore, type RecordingRecoveryTransferMetadata, type RecoveryTrackKind } from './recordingRecovery.ts';
import { getRecordingFileExtension } from './recordingMimeTypes.ts';
import { FolderTrackWriteError, recordingPathSegment, type FolderTrackWriter, type TakeFolder } from './recordingTakeFolder.ts';

/** Where a recorder's bytes land. Recorders only depend on this interface. */
export interface RecordingTrackStore {
  /** Stable id: the browser backup id, or a folder track id. */
  readonly id: string;
  append(data: Blob): void;
  flush(): Promise<void>;
  /** Committed bytes so far, in capture order; always a prefix of finish(). */
  snapshot(mimeType?: string): Promise<Blob>;
  finish(mimeType?: string, options?: { header?: Blob }): Promise<Blob>;
  discard(): Promise<void>;
  /** 'folder' while the recording folder takes the bytes; 'browser' for OPFS. */
  location(): RecordingTrackStoreLocation;
  /** Folder path of the finished file, when written to the recording folder. */
  folderPath?(): string | undefined;
  markDelivered?(): Promise<void>;
  updateTransferCapture?(capture: unknown): Promise<void>;
}

export type RecordingTrackStoreLocation = 'folder' | 'browser';

export interface RecordingTrackStoreInput {
  roomName: string;
  label: string;
  kind: RecoveryTrackKind;
  mimeType: string;
  sourceId?: string;
  transfer?: RecordingRecoveryTransferMetadata;
}

export type RecordingTrackStoreFactory = (
  input: RecordingTrackStoreInput,
  onStorageFailure: (message: string, error?: unknown) => void,
) => RecordingTrackStore;

const BROWSER_FALLBACK_MESSAGE = 'Recording is continuing in memory. Keep this tab open until it has been saved.';

/** Default: crash-safe browser storage (OPFS), with an in-memory last resort. */
export const browserRecordingTrackStoreFactory: RecordingTrackStoreFactory = (input, onStorageFailure) => {
  const store = createRecoverableRecordingStore({
    roomName: input.roomName,
    label: input.label,
    kind: input.kind,
    mimeType: input.mimeType,
    ...(input.transfer ? { transfer: input.transfer } : {}),
  }, (error) => onStorageFailure(BROWSER_FALLBACK_MESSAGE, error));
  return {
    id: store.id,
    append: store.append,
    flush: store.flush,
    snapshot: store.snapshot,
    finish: store.finish,
    discard: store.discard,
    location: () => 'browser',
    markDelivered: store.markDelivered,
    updateTransferCapture: store.updateTransferCapture,
  };
};

/** "Maria audio.webm"; segments carry their label suffix. */
export function getTrackFileName(label: string, mimeType: string): string {
  return `${recordingPathSegment(label, 'Track', 100)}.${getRecordingFileExtension(mimeType)}`;
}

export interface FolderRecordingTrackStoreFactoryOptions {
  take: TakeFolder;
  /** Sub-folder inside the take, e.g. the participant's name or "Program". */
  participantName: string | ((input: RecordingTrackStoreInput) => string);
  /** Falls back to browser storage for the rest of a track if the folder fails. */
  fallback?: RecordingTrackStoreFactory;
  onTrackFinished?: (info: { id: string; path: string; bytes: number; input: RecordingTrackStoreInput }) => void;
  writerOptions?: Parameters<TakeFolder['createTrackWriter']>[2];
}

/**
 * Writes each track straight into the take folder. If the folder stops
 * accepting writes (drive unplugged or full), the bytes that were not written
 * and every later chunk go to browser storage instead, and the caller is told
 * so; the finished Blob still contains the whole track in order.
 */
export function createFolderRecordingTrackStoreFactory(options: FolderRecordingTrackStoreFactoryOptions): RecordingTrackStoreFactory {
  return (input, onStorageFailure) => {
    const id = `folder-${crypto.randomUUID()}`;
    const participant = typeof options.participantName === 'function' ? options.participantName(input) : options.participantName;
    const writerReady: Promise<FolderTrackWriter | null> = options.take
      .createTrackWriter(participant, getTrackFileName(input.label, input.mimeType), options.writerOptions)
      .catch((error) => {
        switchToFallback(error, []);
        return null;
      });
    let fallback: RecordingTrackStore | null = null;
    let queue: Promise<void> = Promise.resolve();
    let discarded = false;
    let finishing: Promise<Blob> | undefined;
    let finishedPath: string | undefined;

    function switchToFallback(error: unknown, unwritten: Blob[]) {
      if (fallback) {
        unwritten.forEach((blob) => fallback!.append(blob));
        return;
      }
      fallback = (options.fallback || browserRecordingTrackStoreFactory)(input, onStorageFailure);
      unwritten.forEach((blob) => fallback!.append(blob));
      const reason = error instanceof Error ? error.message : 'The recording folder stopped accepting files.';
      onStorageFailure(`${reason} Recording continues in browser storage on this computer; save it to the folder after the take.`, error);
    }

    const store: RecordingTrackStore = {
      id,
      append(data) {
        if (!data.size || discarded) return;
        queue = queue.then(async () => {
          if (discarded) return;
          const writer = await writerReady;
          if (fallback || !writer) { (fallback as RecordingTrackStore | null)?.append(data); return; }
          try {
            await writer.append(data);
          } catch (error) {
            switchToFallback(error, error instanceof FolderTrackWriteError ? error.unwritten : [data]);
          }
        });
      },
      async flush() {
        await queue;
        const writer = await writerReady;
        if (writer && !fallback) {
          try { await writer.flush(); } catch (error) {
            switchToFallback(error, error instanceof FolderTrackWriteError ? error.unwritten : []);
          }
        }
        await (fallback as RecordingTrackStore | null)?.flush();
      },
      async snapshot(mimeType = input.mimeType) {
        await queue;
        const writer = await writerReady;
        const fallbackStore = fallback as RecordingTrackStore | null;
        const folderPart = writer ? await writer.snapshot(mimeType) : new Blob([]);
        if (!fallbackStore) return folderPart;
        // After a failure the writer reports the unwritten tail too; that tail
        // was handed to the fallback, so only take the committed prefix here.
        const committed = writer ? folderPart.slice(0, writer.committedBytes()) : folderPart;
        return new Blob([committed, await fallbackStore.snapshot(mimeType)], { type: mimeType });
      },
      finish(mimeType = input.mimeType, finishOptions) {
        return finishing ??= (async () => {
          await queue;
          const writer = await writerReady;
          if (writer && !fallback) {
            try {
              const file = await writer.finish({ mimeType, ...(finishOptions?.header ? { header: finishOptions.header } : {}) });
              finishedPath = writer.path;
              try { options.onTrackFinished?.({ id, path: writer.path, bytes: file.size, input }); } catch { /* Observers must not fail the take. */ }
              return file;
            } catch (error) {
              if (error instanceof FolderTrackWriteError) {
                switchToFallback(error, error.unwritten);
              } else {
                // Stitching failed, but every part is committed on the drive:
                // hand back the parts in order so the take stays playable.
                onStorageFailure(error instanceof Error ? error.message : 'The recording file could not be finished.', error);
                const parts = await writer.snapshot(mimeType);
                return finishOptions?.header ? new Blob([finishOptions.header, parts.slice(finishOptions.header.size)], { type: mimeType }) : parts;
              }
            }
          }
          const fallbackStore = fallback as RecordingTrackStore | null;
          const committed = writer ? (await writer.snapshot(mimeType)).slice(0, writer.committedBytes()) : new Blob([]);
          const rest = fallbackStore ? await fallbackStore.finish(mimeType) : new Blob([]);
          const whole = new Blob([committed, rest], { type: mimeType });
          const header = finishOptions?.header;
          return header && whole.size >= header.size ? new Blob([header, whole.slice(header.size)], { type: mimeType }) : whole;
        })();
      },
      async discard() {
        discarded = true;
        await queue;
        const writer = await writerReady;
        await writer?.abort();
        await (fallback as RecordingTrackStore | null)?.discard();
      },
      location: () => (fallback ? 'browser' : 'folder'),
      folderPath: () => finishedPath,
    };
    return store;
  };
}
