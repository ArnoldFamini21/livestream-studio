import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CaptionsStatePayload, SignalMessage } from '@studio/shared';
import type { LiveCaptionSegment, LiveCaptionUpdate } from './useLiveCaptions.ts';
import {
  EMPTY_REMOTE_CAPTIONS,
  applyRemoteCaption,
  createCaptionSendThrottle,
  pruneRemoteInterims,
  type RemoteCaptionState,
} from '../utils/captionMerge.ts';

const SHARE_STORAGE_KEY = 'studio.captions.shareOwnVoice.v1';

interface UseCaptionRelayOptions {
  send: (message: SignalMessage) => void;
  addHandler: (handler: (message: SignalMessage) => void) => () => void;
  connected: boolean;
  localParticipantId: string | null;
  isOperator: boolean;
  isOnStage: boolean;
  /** The operator's own captions switch. */
  captionsEnabled: boolean;
  captionLanguage: string;
  /** Changes when someone is admitted or leaves, so late joiners hear the captions state. */
  admittedParticipantKey: string;
}

function readShareChoice(): boolean {
  try {
    return localStorage.getItem(SHARE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeShareChoice(value: boolean) {
  try {
    localStorage.setItem(SHARE_STORAGE_KEY, value ? '1' : '0');
  } catch {
    // Blocked storage just forgets the choice.
  }
}

/**
 * Live captions for everyone on stage. Each on-stage participant who opts in
 * runs speech recognition on their own microphone (useLiveCaptions) and their
 * segments travel over signaling to the hosts and co-hosts, who merge them
 * into the broadcast caption and the saved transcript with speaker labels.
 */
export function useCaptionRelay({
  send,
  addHandler,
  connected,
  localParticipantId,
  isOperator,
  isOnStage,
  captionsEnabled,
  captionLanguage,
  admittedParticipantKey,
}: UseCaptionRelayOptions) {
  const [remote, setRemote] = useState<RemoteCaptionState>(EMPTY_REMOTE_CAPTIONS);
  const [hostCaptionsState, setHostCaptionsState] = useState<CaptionsStatePayload | null>(null);
  const [shareOwnCaptions, setShareOwnCaptionsState] = useState<boolean>(() => readShareChoice());
  const [clock, setClock] = useState(() => Date.now());
  const throttleRef = useRef(createCaptionSendThrottle());

  const setShareOwnCaptions = useCallback((value: boolean) => {
    setShareOwnCaptionsState(value);
    writeShareChoice(value);
  }, []);

  useEffect(() => addHandler((message) => {
    if (message.type === 'caption-segment') {
      if (!isOperator) return;
      setRemote((current) => applyRemoteCaption(current, message.payload, Date.now()));
    } else if (message.type === 'captions-state') {
      setHostCaptionsState(message.payload);
    }
  }), [addHandler, isOperator]);

  // Operators tell the studio when captions are on, and repeat it when someone is admitted.
  useEffect(() => {
    if (!isOperator || !connected) return;
    send({ type: 'captions-state', payload: { enabled: captionsEnabled, language: captionLanguage } });
  }, [admittedParticipantKey, captionLanguage, captionsEnabled, connected, isOperator, send]);

  const hostCaptionsOn = Boolean(hostCaptionsState?.enabled);
  /** A guest on stage who said yes runs recognition on their own mic. */
  const guestCaptionsActive = !isOperator && isOnStage && hostCaptionsOn && shareOwnCaptions;
  const guestCaptionLanguage = hostCaptionsState?.language || captionLanguage;

  const onLocalCaptionUpdate = useCallback((update: LiveCaptionUpdate) => {
    if (!isOnStage || !localParticipantId) return;
    if (!isOperator && !guestCaptionsActive) return;
    if (!throttleRef.current(update.segmentId, update.final, Date.now())) return;
    send({
      type: 'caption-segment',
      payload: { participantId: localParticipantId, ...update },
    });
  }, [guestCaptionsActive, isOnStage, isOperator, localParticipantId, send]);

  const hasRemoteInterims = Object.keys(remote.interims).length > 0;
  useEffect(() => {
    if (!hasRemoteInterims && remote.finals.length === 0) return undefined;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClock(now);
      setRemote((current) => pruneRemoteInterims(current, now));
    }, 500);
    return () => window.clearInterval(timer);
  }, [hasRemoteInterims, remote.finals.length]);

  // A guest who leaves the stage or loses operator rights drops held state.
  useEffect(() => {
    if (!isOperator) setRemote(EMPTY_REMOTE_CAPTIONS);
  }, [isOperator]);

  const clearRemoteCaptions = useCallback(() => setRemote(EMPTY_REMOTE_CAPTIONS), []);

  const remoteSegments: LiveCaptionSegment[] = remote.finals;
  return useMemo(() => ({
    remote,
    remoteSegments,
    clock,
    hostCaptionsState,
    guestCaptionsActive,
    guestCaptionLanguage,
    shareOwnCaptions,
    setShareOwnCaptions,
    onLocalCaptionUpdate,
    clearRemoteCaptions,
  }), [clearRemoteCaptions, clock, guestCaptionLanguage, guestCaptionsActive, hostCaptionsState, onLocalCaptionUpdate, remote, remoteSegments, setShareOwnCaptions, shareOwnCaptions]);
}
