import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface LiveCaptionSegment {
  id: string;
  speakerName: string;
  text: string;
  interim: boolean;
  timestamp: string;
  confidence?: number;
}

interface UseLiveCaptionsOptions {
  enabled: boolean;
  language: string;
  speakerName: string;
  maxSegments?: number;
}

interface BrowserSpeechRecognitionAlternative {
  transcript: string;
  confidence?: number;
}

interface BrowserSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: BrowserSpeechRecognitionAlternative | undefined;
}

interface BrowserSpeechRecognitionResultList {
  readonly length: number;
  [index: number]: BrowserSpeechRecognitionResult | undefined;
}

interface BrowserSpeechRecognitionEvent {
  resultIndex: number;
  results: BrowserSpeechRecognitionResultList;
}

interface BrowserSpeechRecognitionErrorEvent {
  error?: string;
  message?: string;
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  }
}

function getSpeechRecognitionConstructor(): BrowserSpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function normalizeCaptionText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function createCaptionId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useLiveCaptions({
  enabled,
  language,
  speakerName,
  maxSegments = 12,
}: UseLiveCaptionsOptions) {
  const [segments, setSegments] = useState<LiveCaptionSegment[]>([]);
  const [interimSegment, setInterimSegment] = useState<LiveCaptionSegment | null>(null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const restartTimerRef = useRef<number | null>(null);
  const shouldListenRef = useRef(false);
  const enabledRef = useRef(enabled);
  const speakerNameRef = useRef(speakerName);
  const languageRef = useRef(language);
  const maxSegmentsRef = useRef(maxSegments);

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { speakerNameRef.current = speakerName; }, [speakerName]);
  useEffect(() => { languageRef.current = language; }, [language]);
  useEffect(() => { maxSegmentsRef.current = maxSegments; }, [maxSegments]);

  const supported = useMemo(() => Boolean(getSpeechRecognitionConstructor()), []);

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const stopRecognition = useCallback(() => {
    shouldListenRef.current = false;
    clearRestartTimer();
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.stop();
      } catch {
        try {
          recognition.abort();
        } catch {
          // Already stopped.
        }
      }
    }
    setListening(false);
    setInterimSegment(null);
  }, [clearRestartTimer]);

  const startRecognition = useCallback(() => {
    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition) {
      setError('Live captions are not supported in this browser.');
      setListening(false);
      return;
    }

    clearRestartTimer();
    if (recognitionRef.current) return;
    shouldListenRef.current = true;

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = languageRef.current;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      const finalTexts: string[] = [];
      const confidenceValues: number[] = [];
      let interimText = '';

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const alternative = result?.[0];
        const text = normalizeCaptionText(alternative?.transcript || '');
        if (!result || !text) continue;

        if (result.isFinal) {
          finalTexts.push(text);
          if (typeof alternative?.confidence === 'number') {
            confidenceValues.push(alternative.confidence);
          }
        } else {
          interimText = normalizeCaptionText(`${interimText} ${text}`);
        }
      }

      if (finalTexts.length > 0) {
        const text = normalizeCaptionText(finalTexts.join(' '));
        const confidence = confidenceValues.length > 0
          ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
          : undefined;
        const segment: LiveCaptionSegment = {
          id: createCaptionId('caption'),
          speakerName: speakerNameRef.current,
          text,
          interim: false,
          timestamp: new Date().toISOString(),
          ...(confidence !== undefined ? { confidence } : {}),
        };
        setSegments((current) => [...current, segment].slice(-maxSegmentsRef.current));
        setInterimSegment(null);
      }

      if (interimText) {
        setInterimSegment({
          id: 'caption-interim',
          speakerName: speakerNameRef.current,
          text: interimText,
          interim: true,
          timestamp: new Date().toISOString(),
        });
      }
    };

    recognition.onerror = (event) => {
      const code = event.error || 'unknown';
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        shouldListenRef.current = false;
        setError('Microphone permission is required for live captions.');
      } else if (code !== 'no-speech') {
        setError(event.message || `Caption recognition stopped: ${code}.`);
      }
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      if (enabledRef.current && shouldListenRef.current) {
        restartTimerRef.current = window.setTimeout(() => {
          restartTimerRef.current = null;
          startRecognition();
        }, 500);
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setError(null);
      setListening(true);
    } catch (err) {
      recognitionRef.current = null;
      setListening(false);
      setError(err instanceof Error ? err.message : 'Failed to start live captions.');
    }
  }, [clearRestartTimer]);

  useEffect(() => {
    if (enabled) {
      startRecognition();
    } else {
      stopRecognition();
    }
    return () => {
      stopRecognition();
    };
  }, [enabled, language, startRecognition, stopRecognition]);

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = window.setInterval(() => setClock(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [enabled]);

  const activeCaption = useMemo(() => {
    if (!enabled) return null;
    if (interimSegment?.text) return interimSegment;
    const last = segments[segments.length - 1];
    if (!last) return null;
    const ageMs = clock - Date.parse(last.timestamp);
    return Number.isFinite(ageMs) && ageMs < 7000 ? last : null;
  }, [clock, enabled, interimSegment, segments]);

  const clearCaptions = useCallback(() => {
    setSegments([]);
    setInterimSegment(null);
  }, []);

  return {
    supported,
    listening,
    error,
    activeCaption,
    segments,
    clearCaptions,
  };
}
