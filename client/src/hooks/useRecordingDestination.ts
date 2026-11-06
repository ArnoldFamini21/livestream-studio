import { useCallback, useEffect, useRef, useState } from 'react';
import { pickRecordingFolder, type RecordingFolderDirectoryHandle } from '../utils/recordingFolderSave.ts';
import {
  createIndexedDbRecordingFolderStore,
  ensureRecordingFolderAccess,
  getRecordingFolderStatus,
  isDirectRecordingFolderSupported,
  probeRecordingFolder,
  requestPersistentRecordingStorage,
  type PersistentStorageResult,
  type RecordingFolderStatus,
} from '../utils/recordingFolderStore.ts';
import { openTakeFolder, TAKE_MANIFEST_FILE_NAME, type TakeDirectoryHandle, type TakeFolder } from '../utils/recordingTakeFolder.ts';
import { createFolderRecordingTrackStoreFactory, type RecordingTrackStoreFactory, type RecordingTrackStoreInput } from '../utils/recordingTrackStore.ts';
import { buildTakeManifest, timelineNow, withClockOffset, type TakeManifestTrackInput } from '../utils/recordingTakeManifest.ts';
import { normalizeRecordingCaptureMetadata, type RecordingCaptureMetadata } from '../utils/recordingCaptureMetadata.ts';
import type { ReceivedTrackEntry } from '../utils/recordingTransferSession.ts';

/**
 * The host's recording destination: a folder (usually on an external SSD)
 * chosen once, remembered across visits, and written to directly while
 * recording. Also builds the per-take manifest used to align tracks.
 */

const PREFERENCES_KEY = 'studio-recording-destination-preferences';

export interface RecordingDestinationPreferences {
  losslessAudio: boolean;
  cloudUpload: boolean;
}

function readPreferences(): RecordingDestinationPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || '{}');
    return { losslessAudio: value.losslessAudio === true, cloudUpload: value.cloudUpload === true };
  } catch {
    return { losslessAudio: false, cloudUpload: false };
  }
}

function writePreferences(preferences: RecordingDestinationPreferences) {
  try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* Preferences are a convenience. */ }
}

interface TakeState {
  sessionId: string;
  folder: Promise<TakeFolder>;
  startedAtMs: number;
  stoppedAtMs?: number;
  pauses: Array<{ startMs: number; endMs?: number }>;
  tracks: Map<string, TakeManifestTrackInput>;
  writeTimer: ReturnType<typeof setTimeout> | null;
  persistedGroups: Set<string>;
}

export function useRecordingDestination(studioName: string, roomId?: string | null) {
  const supported = isDirectRecordingFolderSupported();
  const storeRef = useRef(createIndexedDbRecordingFolderStore());
  const [handle, setHandle] = useState<RecordingFolderDirectoryHandle | null>(null);
  const [status, setStatus] = useState<RecordingFolderStatus>(supported ? 'none' : 'unsupported');
  const [error, setError] = useState<string | null>(null);
  const [persistence, setPersistence] = useState<PersistentStorageResult | null>(null);
  const [preferences, setPreferencesState] = useState<RecordingDestinationPreferences>(readPreferences);
  const takesRef = useRef(new Map<string, TakeState>());
  const studioNameRef = useRef(studioName);
  studioNameRef.current = studioName;

  const refreshStatus = useCallback(async (current: RecordingFolderDirectoryHandle | null) => {
    if (!supported) { setStatus('unsupported'); return 'unsupported' as const; }
    const next = await getRecordingFolderStatus(current);
    setStatus(next);
    return next;
  }, [supported]);

  // Remembered folder from an earlier visit.
  useEffect(() => {
    let cancelled = false;
    if (!supported || !storeRef.current) return;
    void storeRef.current.get().then(async (stored) => {
      if (cancelled || !stored) return;
      setHandle(stored);
      await refreshStatus(stored);
    }).catch(() => {});
    void requestPersistentRecordingStorage().then((result) => { if (!cancelled) setPersistence(result); });
    return () => { cancelled = true; };
  }, [refreshStatus, supported]);

  /** Click handler: pick a folder once; it is remembered for next time. */
  const chooseFolder = useCallback(async () => {
    setError(null);
    try {
      const picked = await pickRecordingFolder();
      if (!(await ensureRecordingFolderAccess(picked))) throw new Error('Write access to that folder was not granted.');
      setHandle(picked);
      setStatus('ready');
      await storeRef.current?.set(picked).catch(() => {});
      setPersistence(await requestPersistentRecordingStorage());
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') return;
      setError(failure instanceof Error ? failure.message : 'Could not use that folder.');
    }
  }, []);

  /**
   * Click handler: re-grant access to the remembered folder (one click, no
   * picker). Returns true when the folder is ready to record into.
   */
  const reconnectFolder = useCallback(async (): Promise<boolean> => {
    if (!handle) return false;
    setError(null);
    const granted = await ensureRecordingFolderAccess(handle);
    if (!granted) {
      setStatus(await getRecordingFolderStatus(handle));
      setError('Access to the recording folder was not granted. Recording will use browser storage.');
      return false;
    }
    try {
      await probeRecordingFolder(handle);
    } catch {
      setError('The recording folder is not available. Is the drive plugged in?');
      return false;
    }
    setStatus('ready');
    return true;
  }, [handle]);

  const forgetFolder = useCallback(async () => {
    setHandle(null);
    setStatus(supported ? 'none' : 'unsupported');
    await storeRef.current?.clear().catch(() => {});
  }, [supported]);

  const setPreferences = useCallback((patch: Partial<RecordingDestinationPreferences>) => {
    setPreferencesState((current) => {
      const next = { ...current, ...patch };
      writePreferences(next);
      return next;
    });
  }, []);

  const scheduleManifest = useCallback((take: TakeState, immediate = false) => {
    if (take.writeTimer) clearTimeout(take.writeTimer);
    const write = () => {
      take.writeTimer = null;
      void take.folder.then((folder) => folder.writeJson(TAKE_MANIFEST_FILE_NAME, buildTakeManifest({
        takeId: take.sessionId,
        studioName: studioNameRef.current,
        ...(roomId ? { roomId } : {}),
        folder: folder.path,
        startedAtMs: take.startedAtMs,
        ...(take.stoppedAtMs ? { stoppedAtMs: take.stoppedAtMs } : {}),
        timeOrigin: typeof performance !== 'undefined' ? performance.timeOrigin : take.startedAtMs,
        pauses: take.pauses,
        tracks: [...take.tracks.values()],
      }))).catch((failure) => console.warn('Could not write the take manifest:', failure));
    };
    if (immediate) write();
    else take.writeTimer = setTimeout(write, 1_000);
  }, [roomId]);

  const openTake = useCallback((sessionId: string, startedAtMs: number, suffix?: string): TakeState => {
    const existing = takesRef.current.get(sessionId);
    if (existing) return existing;
    if (!handle) throw new Error('No recording folder is connected.');
    const take: TakeState = {
      sessionId,
      startedAtMs,
      pauses: [],
      tracks: new Map(),
      writeTimer: null,
      persistedGroups: new Set(),
      folder: openTakeFolder(handle as TakeDirectoryHandle, {
        studioName: studioNameRef.current,
        startedAt: new Date(startedAtMs),
        ...(suffix ? { suffix } : {}),
      }),
    };
    take.folder.catch((failure) => setError(failure instanceof Error ? failure.message : 'Could not create the take folder.'));
    takesRef.current.set(sessionId, take);
    scheduleManifest(take);
    return take;
  }, [handle, scheduleManifest]);

  /**
   * Start a take in the folder. Returns storage factories for the program and
   * the host's own tracks, or null when recording falls back to the browser.
   */
  const beginTake = useCallback(async (sessionId: string, hostName: string, startedAtMs = timelineNow()): Promise<{
    folder: TakeFolder;
    program: RecordingTrackStoreFactory;
    host: RecordingTrackStoreFactory;
    /** Tracks recorded on this computer under another person's (or "Tracks") folder. */
    forParticipant: (participantName: string) => RecordingTrackStoreFactory;
  } | null> => {
    // Fresh check: a click may have just re-granted access.
    if (!handle || await getRecordingFolderStatus(handle) !== 'ready') return null;
    const take = openTake(sessionId, startedAtMs);
    let folder: TakeFolder;
    try { folder = await take.folder; } catch { takesRef.current.delete(sessionId); return null; }
    const track = (participantName: string, origin: TakeManifestTrackInput['origin']) => ({ id, path, bytes, input }: { id: string; path: string; bytes: number; input: RecordingTrackStoreInput }) => {
      take.tracks.set(id, {
        participantName, label: input.label, kind: input.kind, path, mimeType: input.mimeType, bytes, origin, status: 'complete',
        ...(input.mimeType === 'audio/wav' ? { lossless: true } : {}),
        ...(origin === 'program' ? { capture: programCapture(take, input.mimeType) } : {}),
      });
      scheduleManifest(take);
    };
    const factories = new Map<string, RecordingTrackStoreFactory>();
    const forParticipant = (participantName: string) => {
      let factory = factories.get(participantName);
      if (!factory) {
        factory = createFolderRecordingTrackStoreFactory({ take: folder, participantName, onTrackFinished: track(participantName, 'host') });
        factories.set(participantName, factory);
      }
      return factory;
    };
    return {
      folder,
      program: createFolderRecordingTrackStoreFactory({ take: folder, participantName: 'Program', onTrackFinished: track('Program', 'program') }),
      host: forParticipant(hostName),
      forParticipant,
    };
  }, [handle, openTake, scheduleManifest]);

  /** Timing for the host's own tracks once the recorder reports it. */
  const attachCaptures = useCallback((sessionId: string, files: Array<{ label: string; capture?: RecordingCaptureMetadata }>) => {
    const take = takesRef.current.get(sessionId);
    if (!take) return;
    for (const file of files) {
      const entry = [...take.tracks.values()].find((track) => track.label === file.label && track.origin === 'host');
      if (entry && file.capture) entry.capture = file.capture;
    }
    scheduleManifest(take);
  }, [scheduleManifest]);

  const notePause = useCallback((sessionId: string, paused: boolean, at = timelineNow()) => {
    const take = takesRef.current.get(sessionId);
    if (!take) return;
    const last = take.pauses[take.pauses.length - 1];
    if (paused && (!last || last.endMs !== undefined)) take.pauses.push({ startMs: at });
    if (!paused && last && last.endMs === undefined) last.endMs = at;
    scheduleManifest(take);
  }, [scheduleManifest]);

  const endTake = useCallback((sessionId: string, at = timelineNow()) => {
    const take = takesRef.current.get(sessionId);
    if (!take) return;
    take.stoppedAtMs = at;
    const last = take.pauses[take.pauses.length - 1];
    if (last && last.endMs === undefined) last.endMs = at;
    scheduleManifest(take, true);
  }, [scheduleManifest]);

  /** Folder for a guest's track: its take, or a "recovered" take for older ones. */
  const getTakeFolder = useCallback((sessionId: string): Promise<TakeFolder> => {
    const existing = takesRef.current.get(sessionId);
    if (existing) return existing.folder;
    return openTake(sessionId, Date.now(), 'recovered').folder;
  }, [openTake]);

  /** Record a guest track that finished arriving; returns the group's files once all are in. */
  const recordReceivedTrack = useCallback((entry: ReceivedTrackEntry, clockOffsetMs: number | undefined, groupEntries: ReceivedTrackEntry[]) => {
    const take = takesRef.current.get(entry.announcement.sessionId);
    if (!take || !entry.path) return null;
    const normalized = normalizeRecordingCaptureMetadata(entry.capture);
    const capture = normalized ? withClockOffset(normalized, clockOffsetMs) : undefined;
    take.tracks.set(entry.id, {
      participantId: entry.participantId,
      participantName: entry.participantName,
      label: entry.announcement.label,
      kind: entry.announcement.kind,
      path: entry.path,
      mimeType: entry.announcement.mimeType,
      bytes: entry.received,
      origin: 'guest-transfer',
      status: 'complete',
      ...(entry.announcement.lossless ? { lossless: true } : {}),
      ...(capture ? { capture } : {}),
    });
    scheduleManifest(take);
    const groupKey = `${entry.participantName}`;
    if (take.persistedGroups.has(groupKey) || groupEntries.some((candidate) => candidate.status === 'receiving')) return null;
    take.persistedGroups.add(groupKey);
    return groupEntries.filter((candidate) => candidate.status === 'complete' && candidate.file).map((candidate) => {
      const candidateCapture = normalizeRecordingCaptureMetadata(candidate.capture);
      return {
        label: candidate.announcement.label,
        kind: candidate.announcement.kind,
        blob: candidate.file as Blob,
        fileName: candidate.path?.split('/').pop() || candidate.announcement.label,
        ...(candidateCapture ? { capture: withClockOffset(candidateCapture, clockOffsetMs) } : {}),
      };
    });
  }, [scheduleManifest]);

  useEffect(() => () => {
    for (const take of takesRef.current.values()) if (take.writeTimer) clearTimeout(take.writeTimer);
  }, []);

  return {
    supported,
    status,
    folderName: (handle as { name?: string } | null)?.name || null,
    ready: status === 'ready' && Boolean(handle),
    error,
    persistence,
    preferences,
    setPreferences,
    chooseFolder,
    reconnectFolder,
    forgetFolder,
    refreshStatus: () => refreshStatus(handle),
    beginTake,
    attachCaptures,
    notePause,
    endTake,
    getTakeFolder,
    recordReceivedTrack,
  };
}

function programCapture(take: TakeState, mimeType: string): RecordingCaptureMetadata {
  return {
    sourceId: 'program',
    sourceKind: 'program',
    sourceLabel: 'Program',
    mimeType,
    requestedBitsPerSecond: null,
    startedAt: new Date(take.startedAtMs).toISOString(),
    trackCount: 0,
    tracks: [],
    timeline: {
      startMs: take.startedAtMs,
      timeOrigin: typeof performance !== 'undefined' ? performance.timeOrigin : take.startedAtMs,
      pauses: take.pauses,
      segmentIndex: 0,
      ...(take.stoppedAtMs ? { stopMs: take.stoppedAtMs } : {}),
    },
  };
}
