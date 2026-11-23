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
import { buildTakeManifest, timelineNow, withClockOffset, type ExpectedTakeTrack, type TakeManifest, type TakeManifestTrackInput } from '../utils/recordingTakeManifest.ts';
import { normalizeRecordingCaptureMetadata, type RecordingCaptureMetadata } from '../utils/recordingCaptureMetadata.ts';
import { readStudioTakes } from '../utils/recordingTakeChecklist.ts';
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
  previousTracks: TakeManifest['tracks'];
  expectedTracks: ExpectedTakeTrack[];
  timeOrigin: number;
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
  const openingRef = useRef(new Map<string, Promise<TakeFolder>>());
  const [takeManifests, setTakeManifests] = useState<TakeManifest[]>([]);
  const [takeHistoryError, setTakeHistoryError] = useState<string | null>(null);
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

  useEffect(() => {
    let current = true;
    setTakeManifests([]);
    setTakeHistoryError(null);
    if (status === 'ready' && handle && roomId) {
      void readStudioTakes(handle as TakeDirectoryHandle, studioName, roomId).then(stored => {
        if (!current) return;
        setTakeManifests(existing => {
          const known = new Set(existing.map(take => take.takeId));
          return [...existing, ...stored.map(entry => entry.manifest).filter(take => !known.has(take.takeId))];
        });
      }).catch(() => {
        if (current) setTakeHistoryError('Could not read takes from the recording folder.');
      });
    }
    return () => { current = false; };
  }, [handle, roomId, status, studioName]);

  const writeManifest = useCallback(async (take: TakeState) => {
    const folder = await take.folder;
    const manifest = buildTakeManifest({
      takeId: take.sessionId,
      studioName: studioNameRef.current,
      ...(roomId ? { roomId } : {}),
      folder: folder.path,
      startedAtMs: take.startedAtMs,
      ...(take.stoppedAtMs ? { stoppedAtMs: take.stoppedAtMs } : {}),
      timeOrigin: take.timeOrigin,
      pauses: take.pauses,
      expectedTracks: take.expectedTracks,
      tracks: [...take.tracks.values()],
    });
    const newPaths = new Set(manifest.tracks.map(track => track.path));
    const newIds = new Set(manifest.tracks.map(track => track.trackId).filter(Boolean));
    manifest.tracks.unshift(...take.previousTracks.filter(track => !newPaths.has(track.path)
      && (!track.trackId || !newIds.has(track.trackId))));
    await folder.writeJson(TAKE_MANIFEST_FILE_NAME, manifest);
    setTakeManifests(current => [manifest, ...current.filter(item => item.takeId !== manifest.takeId)].slice(0, 20));
  }, [roomId]);

  const scheduleManifest = useCallback((take: TakeState, immediate = false) => {
    if (take.writeTimer) clearTimeout(take.writeTimer);
    const write = () => {
      take.writeTimer = null;
      void writeManifest(take).catch(() => setTakeHistoryError('Could not update the take checklist on the recording drive.'));
    };
    if (immediate) write();
    else take.writeTimer = setTimeout(write, 1_000);
  }, [writeManifest]);

  const openTake = useCallback((sessionId: string, startedAtMs: number, suffix?: string): TakeState => {
    const existing = takesRef.current.get(sessionId);
    if (existing) return existing;
    if (!handle) throw new Error('No recording folder is connected.');
    const take: TakeState = {
      sessionId,
      startedAtMs,
      pauses: [],
      tracks: new Map(),
      previousTracks: [],
      expectedTracks: [],
      timeOrigin: typeof performance === 'undefined' ? startedAtMs : performance.timeOrigin,
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
    return take;
  }, [handle]);

  /**
   * Start a take in the folder. Returns storage factories for the program and
   * the host's own tracks, or null when recording falls back to the browser.
   */
  const beginTake = useCallback(async (
    sessionId: string,
    hostName: string,
    expectedTracks: ExpectedTakeTrack[] = [],
    startedAtMs = timelineNow(),
  ): Promise<{
    folder: TakeFolder;
    program: RecordingTrackStoreFactory;
    host: RecordingTrackStoreFactory;
    /** Tracks recorded on this computer under another person's (or "Tracks") folder. */
    forParticipant: (participantName: string) => RecordingTrackStoreFactory;
  } | null> => {
    // Fresh check: a click may have just re-granted access.
    if (!handle || await getRecordingFolderStatus(handle) !== 'ready') return null;
    const take = openTake(sessionId, startedAtMs);
    take.expectedTracks = expectedTracks;
    let folder: TakeFolder;
    try {
      folder = await take.folder;
      if (take.writeTimer) clearTimeout(take.writeTimer);
      take.writeTimer = null;
      // Record the intended tracks before the first encoder starts.
      await writeManifest(take);
    } catch {
      takesRef.current.delete(sessionId);
      setTakeHistoryError('Could not create a take checklist on the recording drive. Recording will use browser storage.');
      return null;
    }
    const track = (participantName: string, origin: TakeManifestTrackInput['origin']) => ({ id, path, bytes, input }: { id: string; path: string; bytes: number; input: RecordingTrackStoreInput }) => {
      take.tracks.set(id, {
        participantName, label: input.label, kind: input.kind, path, mimeType: input.mimeType, bytes, origin, status: 'complete',
        ...(input.mimeType === 'audio/wav' ? { lossless: true } : {}),
        ...(origin === 'program' ? { capture: programCapture(take, input.mimeType) } : {}),
      });
      scheduleManifest(take);
    };
    const factories = new Map<string, RecordingTrackStoreFactory>();
    // Claimed up front, so a guest with the same name gets "<name> (2)" instead.
    const programFolder = folder.participantFolder('local:Program', 'Program');
    const forParticipant = (participantName: string) => {
      let factory = factories.get(participantName);
      if (!factory) {
        const folderName = folder.participantFolder(`local:${participantName}`, participantName);
        factory = createFolderRecordingTrackStoreFactory({ take: folder, participantName: folderName, onTrackFinished: track(participantName, 'host') });
        factories.set(participantName, factory);
      }
      return factory;
    };
    return {
      folder,
      program: createFolderRecordingTrackStoreFactory({ take: folder, participantName: programFolder, onTrackFinished: track('Program', 'program') }),
      host: forParticipant(hostName),
      forParticipant,
    };
  }, [handle, openTake, scheduleManifest, writeManifest]);

  /** Timing for the host's own tracks once the recorder reports it. */
  const attachCaptures = useCallback(async (sessionId: string, files: Array<{ label: string; capture?: RecordingCaptureMetadata }>) => {
    const take = takesRef.current.get(sessionId);
    if (!take) return;
    for (const file of files) {
      const entry = [...take.tracks.values()].find((track) => track.label === file.label && track.origin === 'host');
      if (entry && file.capture) entry.capture = file.capture;
    }
    try { await writeManifest(take); }
    catch { setTakeHistoryError('Could not save track timing to the take checklist on the recording drive.'); }
  }, [writeManifest]);

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
    const opening = openingRef.current.get(sessionId);
    if (opening) return opening;
    const pending = (async () => {
      const restored = handle && roomId
        ? (await readStudioTakes(handle as TakeDirectoryHandle, studioNameRef.current, roomId, sessionId))[0]
        : undefined;
      if (!restored) {
        const take = openTake(sessionId, timelineNow(), 'recovered');
        await writeManifest(take);
        return take.folder;
      }
      const { folder, manifest } = restored;
      await folder.reserveExistingParticipants();
      const stoppedAt = manifest.stoppedAt && Date.parse(manifest.stoppedAt);
      takesRef.current.set(sessionId, {
        sessionId, folder: Promise.resolve(folder), startedAtMs: manifest.startedAtMs,
        stoppedAtMs: typeof stoppedAt === 'number' && Number.isFinite(stoppedAt) ? stoppedAt : timelineNow(),
        pauses: manifest.pauses
          .filter(pause => pause && Number.isFinite(pause.startOffsetMs) && Number.isFinite(pause.endOffsetMs))
          .map(pause => ({ startMs: manifest.startedAtMs + pause.startOffsetMs, endMs: manifest.startedAtMs + pause.endOffsetMs })),
        tracks: new Map(), previousTracks: manifest.tracks, expectedTracks: manifest.expectedTracks ?? [],
        timeOrigin: manifest.timeOrigin, writeTimer: null, persistedGroups: new Set(),
      });
      return folder;
    })().finally(() => openingRef.current.delete(sessionId));
    openingRef.current.set(sessionId, pending);
    return pending;
  }, [handle, openTake, roomId, writeManifest]);

  /** Record a guest track that finished arriving; returns the group's files once all are in. */
  const recordReceivedTrack = useCallback(async (entry: ReceivedTrackEntry, clockOffsetMs: number | undefined, groupEntries: ReceivedTrackEntry[]) => {
    const take = takesRef.current.get(entry.announcement.sessionId);
    if (!take || !entry.path) return null;
    const normalized = normalizeRecordingCaptureMetadata(entry.capture);
    const capture = normalized ? withClockOffset(normalized, clockOffsetMs) : undefined;
    take.tracks.set(entry.id, {
      trackId: entry.id,
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
    await writeManifest(take);
    // By participant, not display name: two guests called "Maria" are two groups.
    const groupKey = `participant:${entry.participantId}`;
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
  }, [writeManifest]);

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
    takeManifests,
    takeHistoryError,
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
