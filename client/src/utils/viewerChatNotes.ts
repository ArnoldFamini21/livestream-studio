import type { ChatOverlayState, ViewerChatSwitches } from '@studio/shared';

/**
 * The plain sentences a person in the studio reads about who sees their
 * public chat lines. Kept apart from the screens so they can be tested.
 */

/**
 * The note under the Public chat box. A host or co-host knows whether viewer
 * chat is on (`viewerChatOn` is true or false); a guest does not (`undefined`),
 * so for them the sentence is true either way.
 */
export function publicChatNote(viewerChatOn: boolean | undefined): string {
  if (viewerChatOn === true) return 'Visible to everyone in the studio and on the watch page';
  if (viewerChatOn === false) return 'Visible to everyone in the studio';
  return 'Visible to everyone in the studio, and on the watch page if viewer chat is on';
}

/**
 * True when a viewer's message would reach the broadcast picture the moment it
 * is sent: viewer chat is on, Chat on screen is on, and it shows all comments.
 */
export function viewerMessagesGoStraightOnAir(
  switches: Pick<ViewerChatSwitches, 'chat'>,
  overlay: Pick<ChatOverlayState, 'enabled' | 'mode'> | undefined,
): boolean {
  return switches.chat && overlay?.enabled === true && overlay.mode === 'all';
}

/**
 * The text of a pinned line. A message from the watch page says so, with the
 * name the viewer typed: a viewer who calls themselves "Host" must not read as
 * the host in the pinned note either.
 */
export function pinnedNoteText(message: { content: string; senderName: string; source?: { platform: string } }): string {
  return message.source?.platform === 'watch' ? `${message.senderName} (viewer): ${message.content}` : message.content;
}
