import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CaptionsStatePayload, SignalMessage } from '@studio/shared';
import type { LiveCaptionSegment, LiveCaptionUpdate } from './useLiveCaptions.ts';
import {
  EMPTY_REMOTE_CAPTIONS,
  applyRemoteCaption,
  createCaptionSendThrottle,
  getNextCaptionExpiryDelayMs,
  pruneRemoteInterims,
  type RemoteCaptionState,
} from '../utils/captionMerge.ts';
import {
  pickAuthoritativeCaptionsState,
  readCaptionShareChoice,
  writeCaptionShareChoice,
} from '../utils/captionShareConsent.ts';

interface UseCaptionRelayOptions {
  send: (message: SignalMessage) => void;
  addHandler: (handler: (message: SignalMessage) => void) => () => void;
  connected: boolean;
  /** The guest's "Caption my voice" consent is kept for this studio only. */
  roomId: string | null;
  localParticipantId: string | null;
  isOperator: boolean;
  isOnStage: boolean;
  /** This client is the stage owner, whose captions switch speaks for the studio. */
  isStageOwner: boolean;
  /** The stage owner's id: guests follow only its captions-state. */
  stageOwnerId: string | null;
  /** The operator's own captions switch. */
  captionsEnabled: boolean;
  captionLanguage: string;
  /** Changes when someone is admitted or leaves, so late joiners hear the captions state. */
  admittedParticipantKey: string;
  /**
   * Our mic is muted or we are talking backstage: nothing we say may be
   * captioned (speech recognition hears the device, not the published track).
   */
  localCaptionsBlocked: boolean;
  /** Operators: whether a remote speaker may be captioned now (mic on, not talking backstage). */
  acceptRemoteCaption?: (participantId: string) => boolean;
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
  roomId,
  localParticipantId,
  isOperator,
  isOnStage,
  isStageOwner,
  stageOwnerId,
  captionsEnabled,
  captionLanguage,
  admittedParticipantKey,
  localCaptionsBlocked,
  acceptRemoteCaption,
}: UseCaptionRelayOptions) {
  const [remote, setRemote] = useState<RemoteCaptionState>(EMPTY_REMOTE_CAPTIONS);
  // Last captions-state per operator; only the stage owner's counts.
  const [captionsStates, setCaptionsStates] = useState<Record<string, CaptionsStatePayload>>({});
  const [shareOwnCaptions, setShareOwnCaptionsState] = useState<boolean>(() => readCaptionShareChoice(roomId));
  const [clock, setClock] = useState(() => Date.now());
  const throttleRef = useRef(createCaptionSendThrottle());
  const acceptRemoteRef = useRef(acceptRemoteCaption);
  useEffect(() => { acceptRemoteRef.current = acceptRemoteCaption; }, [acceptRemoteCaption]);

  // A different studio starts with the consent off (or what was chosen there in this tab).
  useEffect(() => {
    setShareOwnCaptionsState(readCaptionShareChoice(roomId));
  }, [roomId]);

  const setShareOwnCaptions = useCallback((value: boolean) => {
    setShareOwnCaptionsState(value);
    writeCaptionShareChoice(roomId, value);
  }, [roomId]);

  useEffect(() => addHandler((message) => {
    if (message.type === 'caption-segment') {
      if (!isOperator) return;
      const accept = acceptRemoteRef.current;
      if (accept && !accept(message.payload.participantId)) return;
      const receivedAt = Date.now();
      setRemote((current) => applyRemoteCaption(current, message.payload, receivedAt));
      // The broadcast pick compares against this clock; keep it current when a line arrives.
      setClock(receivedAt);
    } else if (message.type === 'captions-state') {
      const from = message.payload.from;
      if (!from) return;
      setCaptionsStates((current) => ({ ...current, [from]: message.payload }));
    }
  }), [addHandler, isOperator]);

  // The stage owner tells the studio when captions are on, and repeats it when someone is admitted.
  useEffect(() => {
    if (!isOperator || !isStageOwner || !connected) return;
    send({ type: 'captions-state', payload: { enabled: captionsEnabled, language: captionLanguage } });
  }, [admittedParticipantKey, captionLanguage, captionsEnabled, connected, isOperator, isStageOwner, send]);

  const hostCaptionsState = pickAuthoritativeCaptionsState(captionsStates, stageOwnerId);
  const hostCaptionsOn = Boolean(hostCaptionsState?.enabled);
  /** A guest on stage who said yes runs recognition on their own mic. */
  const guestCaptionsActive = !isOperator && isOnStage && hostCaptionsOn && shareOwnCaptions;
  const guestCaptionLanguage = hostCaptionsState?.language || captionLanguage;

  const onLocalCaptionUpdate = useCallback((update: LiveCaptionUpdate) => {
    if (!isOnStage || !localParticipantId || localCaptionsBlocked) return;
    if (!isOperator && !guestCaptionsActive) return;
    if (!throttleRef.current(update.segmentId, update.final, Date.now())) return;
    send({
      type: 'caption-segment',
      payload: { participantId: localParticipantId, ...update },
    });
  }, [guestCaptionsActive, isOnStage, isOperator, localCaptionsBlocked, localParticipantId, send]);

  // Tick only until the newest remote line or interim runs out, then stop.
  useEffect(() => {
    const delay = getNextCaptionExpiryDelayMs(remote, Date.now());
    if (delay === null) return undefined;
    const timer = window.setTimeout(() => {
      const now = Date.now();
      setClock(now);
      setRemote((current) => pruneRemoteInterims(current, now));
    }, Math.max(16, delay));
    return () => window.clearTimeout(timer);
  }, [clock, remote]);

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
