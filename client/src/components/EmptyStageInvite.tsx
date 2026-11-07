import { useEffect, useState } from 'react';

interface EmptyStageInviteProps {
  roomId: string;
  inviteUrl: string;
  onOpenInvite: () => void;
  onChooseRecordingFolder?: () => void;
}

const storageKey = (roomId: string) => `emptyStageInviteDismissed:${roomId}`;

function readDismissed(roomId: string): boolean {
  try {
    return localStorage.getItem(storageKey(roomId)) === '1';
  } catch {
    return false;
  }
}

/**
 * First-time host alone on the stage: say what to do next. This card sits over
 * the stage preview only; the program (recording and stream) is drawn from the
 * video elements, so it never appears on air.
 */
export function EmptyStageInvite({ roomId, inviteUrl, onOpenInvite, onChooseRecordingFolder }: EmptyStageInviteProps) {
  const [dismissed, setDismissed] = useState(() => readDismissed(roomId));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(storageKey(roomId), '1');
    } catch {
      // Remembering the dismissal is a convenience only.
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
    } catch {
      // Clipboard blocked (permissions or insecure context): the invite panel shows the link to copy by hand.
      onOpenInvite();
    }
  };

  return (
    <section className="studio-empty-stage-card" aria-labelledby="empty-stage-title">
      <button type="button" className="studio-empty-stage-dismiss" onClick={dismiss} aria-label="Hide this tip">×</button>
      <h2 id="empty-stage-title">Invite your first guest</h2>
      <p>Send your guest the link. They check their camera and mic, then wait in the green room until you bring them on stage.</p>
      <div className="studio-empty-stage-actions">
        <button type="button" className="studio-empty-primary" onClick={() => void copyLink()}>
          {copied ? 'Link copied' : 'Copy guest link'}
        </button>
        <button type="button" className="studio-empty-secondary" onClick={onOpenInvite}>More invite options</button>
        {onChooseRecordingFolder && (
          <button type="button" className="studio-empty-secondary" onClick={onChooseRecordingFolder}>Choose recording folder</button>
        )}
      </div>
      <span className="studio-sr-only" role="status">{copied ? 'Guest link copied' : ''}</span>
    </section>
  );
}
