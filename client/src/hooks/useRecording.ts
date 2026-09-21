import { useState, useRef, useCallback, useEffect } from 'react';
import { createRecoverableRecordingStore } from '../utils/recordingRecovery.ts';
import type { RecordingUploadTrackKind } from '@studio/shared';
import {
  getPreferredVideoRecordingMimeType,
  getRecordingFileExtension,
} from '../utils/recordingMimeTypes.ts';

export interface RecordingStreamInput {
  stream: MediaStream;
  name: string;
  isLocal: boolean;
  kind?: RecordingUploadTrackKind;
  cleanup?: () => void;
}

export interface RecordingTrackResult {
  name: string;
  blob: Blob;
  kind?: RecordingUploadTrackKind;
}

interface RecordingTrack {
  participantId: string;
  name: string;
  kind?: RecordingUploadTrackKind;
  recorder: MediaRecorder;
  chunkStore: ReturnType<typeof createRecoverableRecordingStore>;
  finished: Promise<Blob>;
  cleanup?: () => void;
  cleanedUp?: boolean;
}

export function useRecording(roomName = 'Studio') {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);
  const tracksRef = useRef<Map<string, RecordingTrack>>(new Map());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const pausedAtRef = useRef<number | null>(null);
  const accumulatedPausedMsRef = useRef<number>(0);

  // Bug fix #11: Guard against double-stop
  const stoppingRef = useRef<boolean>(false);
  const stopPromiseRef = useRef<Promise<Map<string, RecordingTrackResult>> | null>(null);

  const getMimeType = () => getPreferredVideoRecordingMimeType();

  const cleanupTrack = (track: RecordingTrack) => {
    if (track.cleanedUp) return;
    track.cleanedUp = true;
    try {
      track.cleanup?.();
    } catch (err) {
      console.warn(`Failed to clean up recording source for ${track.name}:`, err);
    }
  };

  const getElapsedSeconds = useCallback(() => {
    if (!startTimeRef.current) return 0;
    const endTime = pausedAtRef.current || Date.now();
    return Math.max(0, Math.floor((endTime - startTimeRef.current - accumulatedPausedMsRef.current) / 1000));
  }, []);

  const startRecording = useCallback(
    (streams: Map<string, RecordingStreamInput>) => {
      // Bug fix #10: Guard against double-start
      if (tracksRef.current.size > 0 || stoppingRef.current) {
        streams.forEach((input) => input.cleanup?.());
        return false;
      }

      const mimeType = getMimeType();
      if (!mimeType) {
        console.error('No supported recording MIME type found');
        streams.forEach((input) => input.cleanup?.());
        return false;
      }

      setStorageWarning(null);
      stopPromiseRef.current = null;
      // Clear previous tracks
      tracksRef.current.forEach(cleanupTrack);
      tracksRef.current.clear();

      for (const [id, { stream, name, kind, cleanup }] of streams) {
        let recorder: MediaRecorder;
        try {
          recorder = new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond: 20_000_000, // 20 Mbps for professional studio quality
            audioBitsPerSecond: 256_000,    // 256 kbps audio
          });
        } catch (err) {
          console.error(`Failed to start recorder for ${name}:`, err);
          cleanup?.();
          continue;
        }

        const chunkStore = createRecoverableRecordingStore({
          roomName, label: name, kind: kind || 'iso', mimeType: recorder.mimeType,
        }, () => setStorageWarning('Recording is continuing in memory. Keep this tab open until it has been saved.'));
        recorder.ondataavailable = (e) => chunkStore.append(e.data);
        let resolveFinished!: (blob: Blob) => void;
        let rejectFinished!: (error: unknown) => void;
        const finished = new Promise<Blob>((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
        // Attach immediately: recorder errors can stop capture before the user
        // presses Stop. The final data event is delivered before this handler.
        recorder.onstop = () => { void chunkStore.finish(recorder.mimeType).then(resolveFinished, rejectFinished); };
        recorder.onerror = () => setStorageWarning('A recording track was interrupted. Stop and save the available footage.');
        const track: RecordingTrack = { participantId: id, name, kind, recorder, chunkStore, finished, cleanup };
        void finished.catch(() => {}); // stopRecording reports failures to its caller.
        tracksRef.current.set(id, track);
        try {
          recorder.start(1000); // Capture in 1-second chunks
        } catch (err) {
          console.error(`Failed to start recording for ${name}:`, err);
          tracksRef.current.delete(id);
          void chunkStore.discard();
          cleanupTrack(track);
        }
      }

      if (tracksRef.current.size === 0) {
        return false;
      }

      startTimeRef.current = Date.now();
      pausedAtRef.current = null;
      accumulatedPausedMsRef.current = 0;
      timerRef.current = setInterval(() => {
        setRecordingTime(getElapsedSeconds());
      }, 1000);

      setIsRecording(true);
      setIsPaused(false);
      console.log(`Recording started: ${streams.size} track(s)`);
      return true;
    },
    [getElapsedSeconds, roomName]
  );

  const pauseRecording = useCallback(() => {
    if (!isRecording || isPaused || stoppingRef.current) return;

    let pausedAny = false;
    for (const [, track] of tracksRef.current) {
      if (track.recorder.state !== 'recording') continue;
      try {
        track.recorder.pause();
        pausedAny = true;
      } catch (err) {
        console.warn(`Failed to pause recording for ${track.name}:`, err);
      }
    }

    if (!pausedAny) return;
    pausedAtRef.current = Date.now();
    setRecordingTime(getElapsedSeconds());
    setIsPaused(true);
  }, [getElapsedSeconds, isPaused, isRecording]);

  const resumeRecording = useCallback(() => {
    if (!isRecording || !isPaused || stoppingRef.current) return;

    let resumedAny = false;
    for (const [, track] of tracksRef.current) {
      if (track.recorder.state !== 'paused') continue;
      try {
        track.recorder.resume();
        resumedAny = true;
      } catch (err) {
        console.warn(`Failed to resume recording for ${track.name}:`, err);
      }
    }

    if (!resumedAny) return;
    const pausedAt = pausedAtRef.current;
    if (pausedAt !== null) {
      accumulatedPausedMsRef.current += Date.now() - pausedAt;
    }
    pausedAtRef.current = null;
    setRecordingTime(getElapsedSeconds());
    setIsPaused(false);
  }, [getElapsedSeconds, isPaused, isRecording]);

  const stopRecording = useCallback((): Promise<Map<string, RecordingTrackResult>> => {
    if (stopPromiseRef.current) return stopPromiseRef.current;
    stoppingRef.current = true;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    const tracks = [...tracksRef.current.entries()];
    stopPromiseRef.current = (async () => {
      try {
        const results = await Promise.all(tracks.map(async ([id, track]) => {
          if (track.recorder.state !== 'inactive') {
            try { track.recorder.stop(); }
            catch { return [id, { name: track.name, kind: track.kind, blob: await track.chunkStore.finish(track.recorder.mimeType) }] as const; }
          }
          const blob = await track.finished;
          return [id, { name: track.name, kind: track.kind, blob }] as const;
        }));
        return new Map(results);
      } finally {
        tracks.forEach(([, track]) => cleanupTrack(track));
        tracksRef.current.clear();
        pausedAtRef.current = null;
        accumulatedPausedMsRef.current = 0;
        setIsRecording(false); setIsPaused(false); setRecordingTime(0);
        stoppingRef.current = false;
      }
    })();
    return stopPromiseRef.current;
  }, []);

  const downloadRecordings = useCallback(async () => {
    const recordings = await stopRecording();
    for (const [, { name, blob }] of recordings) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const extension = getRecordingFileExtension(blob.type);
      a.download = `${name.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 19)}.${extension}`;
      a.click();
      // Bug fix #13: Delay URL.revokeObjectURL to allow download to initiate
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  }, [stopRecording]);

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Bug fix #9: Cleanup on unmount - clear interval, stop recorders, clear tracks
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      pausedAtRef.current = null;
      accumulatedPausedMsRef.current = 0;
      for (const [, track] of tracksRef.current) {
        if (track.recorder.state !== 'inactive') {
          try {
            track.recorder.stop();
          } catch {
            void track.chunkStore.finish(track.recorder.mimeType);
          }
        }
        cleanupTrack(track);
      }
      tracksRef.current.clear();
    };
  }, []);

  return {
    isRecording,
    isPaused,
    storageWarning,
    recordingTime,
    formattedTime: formatTime(recordingTime),
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    downloadRecordings,
  };
}
