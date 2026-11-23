const SCREEN_PRODUCER_PREFIX = 'screen:';

/** The media server derives this ID from the authenticated stage participant. */
export function sfuScreenProducerId(participantId: string): string {
  return `${SCREEN_PRODUCER_PREFIX}${participantId}`;
}

export function sfuScreenProducerOwner(producerId: string): string | null {
  return producerId.startsWith(SCREEN_PRODUCER_PREFIX) ? producerId.slice(SCREEN_PRODUCER_PREFIX.length) || null : null;
}
