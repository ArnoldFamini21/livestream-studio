import { useState, useRef, useCallback, useEffect } from 'react';
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
  chunks: Blob[];
  cleanup?: () => void;
  cleanedUp?: boolean;
}

export function useRecording() {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const tracksRef = useRef<Map<string, RecordingTrack>>(new Map());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const pausedAtRef = useRef<number | null>(null);
  const accumulatedPausedMsRef = useRef<number>(0);

  // Bug fix #11: Guard against double-stop
  const stoppingRef = useRef<boolean>(false);

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
      if (isRecording) {
        streams.forEach((input) => input.cleanup?.());
        return false;
      }

      const mimeType = getMimeType();
      if (!mimeType) {
        console.error('No supported recording MIME type found');
        streams.forEach((input) => input.cleanup?.());
        return false;
      }

      // Clear previous tracks
      tracksRef.current.forEach(cleanupTrack);
      tracksRef.current.clear();

      for (const [id, { stream, name, kind, cleanup }] of streams) {
        const chunks: Blob[] = [];
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

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            chunks.push(e.data);
          }
        };

        recorder.onerror = (e) => {
          console.error(`Recording error for ${name}:`, e);
        };

        const track: RecordingTrack = { participantId: id, name, kind, recorder, chunks, cleanup };
        tracksRef.current.set(id, track);
        try {
          recorder.start(1000); // Capture in 1-second chunks
        } catch (err) {
          console.error(`Failed to start recording for ${name}:`, err);
          tracksRef.current.delete(id);
          cleanupTrack(track);
        }
      }

      if (tracksRef.current.size === 0) {
        streams.forEach((input) => input.cleanup?.());
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
    [getElapsedSeconds, isRecording]
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
    // Bug fix #11: Guard against double-stop
    if (stoppingRef.current) {
      return Promise.resolve(new Map());
    }
    stoppingRef.current = true;

    return new Promise((resolve) => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      pausedAtRef.current = null;
      accumulatedPausedMsRef.current = 0;

      const results = new Map<string, RecordingTrackResult>();
      let pending = tracksRef.current.size;

      if (pending === 0) {
        setIsRecording(false);
        setIsPaused(false);
        setRecordingTime(0);
        stoppingRef.current = false;
        resolve(results);
        return;
      }

      for (const [id, track] of tracksRef.current) {
        // Bug fix #12: Check recorder state before calling stop
        if (track.recorder.state === 'inactive') {
          // Recorder already inactive - collect existing chunks directly
          const blob = new Blob(track.chunks, { type: track.recorder.mimeType });
          results.set(id, { name: track.name, blob, ...(track.kind ? { kind: track.kind } : {}) });
          cleanupTrack(track);
          pending--;
          if (pending === 0) {
            setIsRecording(false);
            setIsPaused(false);
            setRecordingTime(0);
            tracksRef.current.clear();
            stoppingRef.current = false;
            resolve(results);
          }
        } else {
          track.recorder.onstop = () => {
            const blob = new Blob(track.chunks, { type: track.recorder.mimeType });
            results.set(id, { name: track.name, blob, ...(track.kind ? { kind: track.kind } : {}) });
            cleanupTrack(track);
            pending--;
            if (pending === 0) {
              setIsRecording(false);
              setIsPaused(false);
              setRecordingTime(0);
              tracksRef.current.clear();
              stoppingRef.current = false;
              resolve(results);
            }
          };
          track.recorder.stop();
        }
      }
    });
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
            // Recorder may already be in an invalid state
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
    recordingTime,
    formattedTime: formatTime(recordingTime),
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    downloadRecordings,
  };
}
