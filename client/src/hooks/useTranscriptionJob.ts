import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranscriptionProgress } from '../utils/localTranscription.ts';
import {
  requestRecordingTranscription,
  type RecordingTranscriptionResult,
  type RecordingTranscriptionSourceFile,
} from '../utils/recordingTranscription.ts';
import {
  loadTranscriptionSettings,
  saveTranscriptionSettings,
  type TranscriptionSettings,
} from '../utils/transcriptionSettings.ts';

/**
 * Engine/model choice, progress and cancel for one transcript at a time.
 * `run` resolves to null when the job was cancelled.
 */
export function useTranscriptionJob() {
  const [settings, setSettingsState] = useState<TranscriptionSettings>(() => loadTranscriptionSettings());
  const [progress, setProgress] = useState<TranscriptionProgress | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const setSettings = useCallback((next: TranscriptionSettings) => {
    setSettingsState(next);
    saveTranscriptionSettings(next);
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const run = useCallback(async (
    file: RecordingTranscriptionSourceFile,
    language: string | undefined
  ): Promise<RecordingTranscriptionResult | null> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setProgress({ phase: 'preparing', fraction: 0, detail: 'Starting' });
    try {
      return await requestRecordingTranscription(file, {
        language,
        engine: settings.engine,
        model: settings.model,
        signal: controller.signal,
        onProgress: (update) => {
          if (controllerRef.current === controller) setProgress(update);
        },
      });
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return null;
      throw err;
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setProgress(null);
      }
    }
  }, [settings.engine, settings.model]);

  return { settings, setSettings, progress, run, cancel };
}
