import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Participant, RecordingTransferSignalOptions, SignalMessage } from '@studio/shared';
import { useRecordingDestination } from './useRecordingDestination.ts';
import { useRecordingTransfer, type RecordingTransferInvite } from './useRecordingTransfer.ts';
import { useScreenWakeLock } from './useScreenWakeLock.ts';
import {
  assessRecordingStorageHeadroom,
  estimateRecordingStorage,
  requestPersistentRecordingStorage,
  type RecordingStorageHeadroom,
} from '../utils/recordingFolderStore.ts';
import type { RecordingTrackStoreFactory } from '../utils/recordingTrackStore.ts';
import type { TakeFolder } from '../utils/recordingTakeFolder.ts';
import type { ReceivedTrackEntry, TransferSourceTrack } from '../utils/recordingTransferSession.ts';
import type { RecordingCaptureMetadata } from '../utils/recordingCaptureMetadata.ts';
import { describeGuestTransfer } from '../utils/recordingWorkflowPolicy.ts';

/**
 * Riverside-style recording for the free tier, in one place:
 *
 * - Host: records the program and their own tracks straight into the chosen
 *   folder, collects every guest's tracks there peer-to-peer during the take,
 *   and writes the take manifest. The media-server upload is opt-in.
 * - Guest: records locally (browser backup) and streams the tracks to the
 *   host while recording; anything not yet delivered resumes after a reload.
 * - Everyone: Screen Wake Lock while recording, live or on stage.
 */

export interface ReceivedLibraryFile {
  label: string;
  kind: string;
  blob: Blob;
  fileName: string;
  capture?: RecordingCaptureMetadata;
}

export interface ActiveTakeStorage {
  sessionId: string;
  folder: TakeFolder;
  program: RecordingTrackStoreFactory;
  /** The host's own tracks (and other locally recorded tracks) under a person's folder. */
  forParticipant(name: string): RecordingTrackStoreFactory;
}

export interface RecordingStartCheck {
  proceed: boolean;
  folderReady: boolean;
  headroom: RecordingStorageHeadroom;
}

interface UseRecordingWorkflowOptions {
  send: (message: SignalMessage) => void;
  addHandler: (handler: (message: SignalMessage) => void) => () => void;
  roomId: string | null | undefined;
  studioName: string;
  me: Participant | null | undefined;
  isOperator: boolean;
  participants: Map<string, Participant>;
  /** The media-server has lasting object storage configured (cloud copy is opt-in). */
  cloudAvailable: boolean;
  /** Recording, live or on stage: keep the screen awake. */
  keepAwake: boolean;
  /** Guest: this page's recorder tracks that can be sent to the host. */
  getLocalTracks: () => TransferSourceTrack[];
  localTracksVersion: number;
  onLocalTrackDelivered: (trackId: string) => void;
  /** Host: a guest's tracks for one take all arrived (for the recording library). */
  onGuestTracksSaved?: (participantName: string, files: ReceivedLibraryFile[]) => void;
  /** Guest: the host stopped collecting tracks over the transfer connection mid-take. */
  onInviteChanged?: (invite: RecordingTransferInvite | null) => void;
}

export function useRecordingWorkflow(options: UseRecordingWorkflowOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const destination = useRecordingDestination(options.studioName, options.roomId);
  const activeTakesRef = useRef(new Map<string, ActiveTakeStorage>());
  const [invite, setInvite] = useState<RecordingTransferInvite | null>(null);
  const wakeLockStatus = useScreenWakeLock(options.keepAwake);

  const hostReceiving = options.isOperator && destination.ready;
  const cloudUploadPreferred = destination.preferences.cloudUpload && options.cloudAvailable;
  const hostOptions = useMemo<RecordingTransferSignalOptions>(() => ({
    losslessAudio: destination.preferences.losslessAudio,
    cloudUpload: cloudUploadPreferred,
  }), [cloudUploadPreferred, destination.preferences.losslessAudio]);

  const registryRef = useRef<ReturnType<typeof useRecordingTransfer>['registry'] | null>(null);
  const transfer = useRecordingTransfer({
    send: options.send,
    addHandler: options.addHandler,
    roomId: options.roomId,
    me: options.me,
    isOperator: options.isOperator,
    participants: options.participants,
    hostReceiving,
    hostOptions,
    getTakeFolder: destination.getTakeFolder,
    onTrackReceived: (entry: ReceivedTrackEntry) => {
      const registry = registryRef.current;
      if (!registry) return;
      const group = [...registry.tracks.values()].filter((candidate) => (
        candidate.participantName === entry.participantName && candidate.announcement.sessionId === entry.announcement.sessionId
      ));
      const files = destination.recordReceivedTrack(entry, registry.getClockOffset(entry.participantId), group);
      if (files?.length) {
        try { optionsRef.current.onGuestTracksSaved?.(entry.participantName, files); } catch { /* Library is best-effort. */ }
      }
    },
    getLocalTracks: options.getLocalTracks,
    localTracksVersion: options.localTracksVersion,
    onLocalTrackDelivered: options.onLocalTrackDelivered,
    onInvite: (next) => { setInvite(next); optionsRef.current.onInviteChanged?.(next); },
    onInviteCleared: () => { setInvite(null); optionsRef.current.onInviteChanged?.(null); },
  });
  registryRef.current = transfer.registry;

  // Changed options (lossless on/off, cloud copy) reach guests with a fresh invite.
  const inviteAllRef = useRef(transfer.inviteAll);
  inviteAllRef.current = transfer.inviteAll;
  const lastHostOptionsRef = useRef<string | null>(null);
  useEffect(() => {
    const key = JSON.stringify(hostOptions);
    if (!hostReceiving) { lastHostOptionsRef.current = null; return; }
    if (lastHostOptionsRef.current !== null && lastHostOptionsRef.current !== key) {
      inviteAllRef.current([...activeTakesRef.current.keys()].pop());
    }
    lastHostOptionsRef.current = key;
  }, [hostOptions, hostReceiving]);

  /**
   * Call first thing in the Record click handler (while the click still
   * counts as a user gesture): re-grants folder access with one click,
   * asks for persistent storage and checks browser storage headroom.
   */
  const prepareStart = useCallback(async (plannedBitsPerSecond: number): Promise<RecordingStartCheck> => {
    let folderReady = destination.ready;
    if (!folderReady && destination.folderName && (destination.status === 'needs-permission' || destination.status === 'denied')) {
      folderReady = await destination.reconnectFolder();
    }
    const [, estimate] = await Promise.all([requestPersistentRecordingStorage(), estimateRecordingStorage()]);
    const headroom = assessRecordingStorageHeadroom({ estimate, bitsPerSecond: plannedBitsPerSecond, folderConnected: folderReady });
    if (headroom.status === 'critical') {
      const proceed = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(`${headroom.message}\n\nStart recording anyway?`)
        : false;
      return { proceed, folderReady, headroom };
    }
    return { proceed: true, folderReady, headroom };
  }, [destination]);

  /** Open the take folder and storage for the program and local tracks; null means browser storage. */
  const beginTake = useCallback(async (sessionId: string, hostName: string): Promise<ActiveTakeStorage | null> => {
    const started = await destination.beginTake(sessionId, hostName);
    if (!started) return null;
    const take: ActiveTakeStorage = {
      sessionId,
      folder: started.folder,
      program: started.program,
      forParticipant: started.forParticipant,
    };
    activeTakesRef.current.set(sessionId, take);
    transfer.inviteAll(sessionId);
    return take;
  }, [destination, transfer]);

  const getActiveTake = useCallback((sessionId: string | null | undefined): ActiveTakeStorage | null => (
    (sessionId && activeTakesRef.current.get(sessionId)) || null
  ), []);

  const endTake = useCallback((sessionId: string) => {
    destination.endTake(sessionId);
    activeTakesRef.current.delete(sessionId);
  }, [destination]);

  const notePause = destination.notePause;
  const attachCaptures = destination.attachCaptures;

  const isGuest = !options.isOperator;
  /** Upload this page's tracks to the media-server? Off when the host collects them directly. */
  const uploadToCloud = isGuest
    ? !invite || invite.options.cloudUpload === true
    : !destination.ready || cloudUploadPreferred;
  const losslessAudio = isGuest ? invite?.options.losslessAudio === true : destination.ready && destination.preferences.losslessAudio;
  const guestLine = isGuest ? describeGuestTransfer(transfer.guestStatus, Boolean(invite)) : null;

  return {
    destination,
    cloudAvailable: options.cloudAvailable,
    transfers: transfer.summaries,
    hostReceiving,
    cloudUploadPreferred,
    invite,
    uploadToCloud,
    losslessAudio,
    guestLine,
    wakeLockStatus,
    prepareStart,
    beginTake,
    getActiveTake,
    endTake,
    notePause,
    attachCaptures,
    waitForHostSettled: transfer.waitForHostSettled,
    waitForDelivery: transfer.waitForDelivery,
  };
}
