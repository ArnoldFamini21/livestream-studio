import { useState, useRef, useCallback, useEffect } from 'react';

interface RecordingTrack {
  participantId: string;
  name: string;
  recorder: MediaRecorder;
  chunks: Blob[];
}

export function useRecording() {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const tracksRef = useRef<Map<string, RecordingTrack>>(new Map());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);

  // Bug fix #11: Guard against double-stop
  const stoppingRef = useRef<boolean>(false);

  const getMimeType = () => {
    const types = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4',
    ];
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  };

  const startRecording = useCallback(
    (streams: Map<string, { stream: MediaStream; name: string; isLocal: boolean }>) => {
      // Bug fix #10: Guard against double-start
      if (isRecording) return;

      const mimeType = getMimeType();
      if (!mimeType) {
        console.error('No supported recording MIME type found');
        return;
      }

      // Clear previous tracks
      tracksRef.current.clear();

      for (const [id, { stream, name }] of streams) {
        const chunks: Blob[] = [];
        const recorder = new MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond: 8_000_000, // 8 Mbps for high quality
          audioBitsPerSecond: 256_000,   // 256 kbps audio
        });

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            chunks.push(e.data);
          }
        };

        recorder.onerror = (e) => {
          console.error(`Recording error for ${name}:`, e);
        };

        tracksRef.current.set(id, { participantId: id, name, recorder, chunks });
        recorder.start(1000); // Capture in 1-second chunks
      }

      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setRecordingTime(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);

      setIsRecording(true);
      console.log(`Recording started: ${streams.size} track(s)`);
    },
    [isRecording]
  );

  const stopRecording = useCallback((): Promise<Map<string, { name: string; blob: Blob }>> => {
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

      const results = new Map<string, { name: string; blob: Blob }>();
      let pending = tracksRef.current.size;

      if (pending === 0) {
        setIsRecording(false);
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
          results.set(id, { name: track.name, blob });
          pending--;
          if (pending === 0) {
            setIsRecording(false);
            setRecordingTime(0);
            tracksRef.current.clear();
            stoppingRef.current = false;
            resolve(results);
          }
        } else {
          track.recorder.onstop = () => {
            const blob = new Blob(track.chunks, { type: track.recorder.mimeType });
            results.set(id, { name: track.name, blob });
            pending--;
            if (pending === 0) {
              setIsRecording(false);
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
      a.download = `${name.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 19)}.webm`;
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
      for (const [, track] of tracksRef.current) {
        if (track.recorder.state !== 'inactive') {
          try {
            track.recorder.stop();
          } catch {
            // Recorder may already be in an invalid state
          }
        }
      }
      tracksRef.current.clear();
    };
  }, []);

  return {
    isRecording,
    recordingTime,
    formattedTime: formatTime(recordingTime),
    startRecording,
    stopRecording,
    downloadRecordings,
  };
}
