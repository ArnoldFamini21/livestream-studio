import { useEffect, useMemo, useRef, useState } from 'react';
import type { Participant, SignalMessage } from '@studio/shared';
import { hasStudioCapability } from '@studio/shared';
import { selectRemoteTalkbackIds } from '../utils/talkback.ts';

interface UseTalkbackRelayOptions {
  send: (message: SignalMessage) => void;
  addHandler: (handler: (message: SignalMessage) => void) => () => void;
  connected: boolean;
  localParticipant: Participant | null;
  /** This operator may talk backstage (admitted host or co-host). */
  enabled: boolean;
  /** This operator is talking backstage right now. */
  localActive: boolean;
  participants: Map<string, Participant>;
}

export interface TalkbackRelayState {
  /** Other operators talking backstage: silence them in any program mix built here. */
  remoteTalkbackIds: string[];
  /** The server echoed our current talkback-state (so the other operators were told). */
  confirmed: boolean;
  /** Other admitted operators whose client cannot apply our talkback to its program mix. */
  operatorsWithoutSupport: number;
}

/**
 * Talk backstage, studio-wide. The local switch only changes this browser's
 * mix; the live relay or program recording may run on another operator's
 * browser. So each operator announces its talkback-state, the server relays
 * it to admitted operators (and echoes it back), and every operator silences
 * everyone talking backstage in the program mix it builds.
 */
export function useTalkbackRelay({
  send,
  addHandler,
  connected,
  localParticipant,
  enabled,
  localActive,
  participants,
}: UseTalkbackRelayOptions): TalkbackRelayState {
  const localId = localParticipant?.id ?? null;
  // A server older than talkback-state does not stamp capabilities on us.
  const serverSupportsTalkback = hasStudioCapability(localParticipant, 'talkback');
  const [reported, setReported] = useState<ReadonlySet<string>>(() => new Set());
  const [echoed, setEchoed] = useState<boolean | null>(null);
  const sentRef = useRef<boolean | null>(null);
  // Bumped on every room-joined (first join, resume, rejoin) so we announce again.
  const [joinNonce, setJoinNonce] = useState(0);

  useEffect(() => addHandler((message) => {
    if (message.type === 'talkback-state') {
      const from = message.payload.from;
      if (!from) return;
      if (from === localId) {
        setEchoed(message.payload.active);
        return;
      }
      setReported((current) => {
        if (current.has(from) === message.payload.active) return current;
        const next = new Set(current);
        if (message.payload.active) next.add(from);
        else next.delete(from);
        return next;
      });
    } else if (message.type === 'participant-left') {
      const gone = message.payload.participantId;
      setReported((current) => {
        if (!current.has(gone)) return current;
        const next = new Set(current);
        next.delete(gone);
        return next;
      });
    } else if (message.type === 'room-joined') {
      // A fresh view of the studio, including a reconnect that may have missed updates.
      setReported(new Set(message.payload.talkbackParticipantIds ?? []));
      setEchoed(null);
      sentRef.current = null;
      setJoinNonce((value) => value + 1);
    }
  }), [addHandler, localId]);

  useEffect(() => {
    if (!connected) {
      sentRef.current = null;
      setEchoed(null);
    }
  }, [connected]);

  // Operators admitted right now, so a newcomer hears that we are talking backstage.
  const operatorKey = useMemo(() => {
    const ids: string[] = [];
    for (const participant of participants.values()) {
      if ((participant.role === 'host' || participant.role === 'co-host') && participant.status !== 'green-room') ids.push(participant.id);
    }
    return ids.sort().join(',');
  }, [participants]);

  useEffect(() => {
    if (!connected || !localId || !serverSupportsTalkback) return;
    if (!enabled) {
      // The server would refuse us now; everyone else drops us by role/status.
      sentRef.current = null;
      return;
    }
    const active = localActive;
    // Announce once per connection, then on every change; repeat "on" when operators change.
    if (sentRef.current === active && !active) return;
    sentRef.current = active;
    setEchoed((current) => (current === active ? current : null));
    send({ type: 'talkback-state', payload: { active } });
  }, [connected, enabled, joinNonce, localActive, localId, operatorKey, send, serverSupportsTalkback]);

  const remoteTalkbackIds = useMemo(
    () => selectRemoteTalkbackIds(reported, participants.values(), localId),
    [localId, participants, reported]
  );
  // Same array while the set of ids is unchanged, so the program mix does not reconcile for nothing.
  const remoteKey = remoteTalkbackIds.join(',');
  const stableRemoteIds = useMemo(() => (remoteKey ? remoteKey.split(',') : []), [remoteKey]);

  const operatorsWithoutSupport = useMemo(() => {
    let count = 0;
    for (const participant of participants.values()) {
      if (participant.id === localId) continue;
      if (participant.role !== 'host' && participant.role !== 'co-host') continue;
      if (participant.status === 'green-room') continue;
      if (!hasStudioCapability(participant, 'talkback')) count += 1;
    }
    return count;
  }, [localId, participants]);

  return {
    remoteTalkbackIds: stableRemoteIds,
    confirmed: serverSupportsTalkback && echoed === localActive && localActive,
    operatorsWithoutSupport,
  };
}
