import { useEffect, useRef } from 'react';
import type { BroadcastOrientation } from '@studio/shared';
import type { RtmpRelayStats } from '../hooks/useRtmpRelay.ts';
import { OTHER_PROGRAM_LAYOUTS, type SecondaryProgramLayout } from '../utils/dualOutput.ts';

export interface DualOutputControlsProps {
  enabled: boolean;
  supportIssue: string | null;
  configurationIssue: string | null;
  destinationLimit: number;
  isLive: boolean;
  isStarting: boolean;
  orientation: BroadcastOrientation;
  layout: SecondaryProgramLayout;
  stream: MediaStream | null;
  stats: RtmpRelayStats;
  onToggle: (enabled: boolean) => void;
  onLayoutChange: (layout: SecondaryProgramLayout) => void;
}

export function DualOutputControls({
  enabled, supportIssue, isLive, isStarting, orientation, layout, stream, stats, onToggle, onLayoutChange,
}: DualOutputControlsProps) {
  const previewRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const preview = previewRef.current;
    if (!preview || !enabled) return;
    preview.srcObject = stream;
    return () => { preview.srcObject = null; };
  }, [stream, enabled]);

  const name = orientation === 'portrait' ? 'Portrait' : 'Landscape';
  return (
    <section className="sd-dual-output" aria-label="Simultaneous stream output">
      <label>
        <input type="checkbox" checked={enabled} onChange={(event) => onToggle(event.target.checked)}
          disabled={isLive || isStarting || (!enabled && Boolean(supportIssue))} />
        Stream landscape and portrait together
      </label>
      {supportIssue && !isLive && <p>{supportIssue}</p>}
      {enabled && (
        <>
          <p>Assign an orientation to each destination. The main stage stays on the watch page and in the relay backup. The second output is 720p and adds about 2.7 Mbps upstream.</p>
          <label>
            {name} layout
            <select value={layout} disabled={isStarting} onChange={(event) => {
              const option = OTHER_PROGRAM_LAYOUTS.find(({ value }) => value === event.target.value);
              if (option) onLayoutChange(option.value);
            }}>
              {OTHER_PROGRAM_LAYOUTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <video ref={previewRef} autoPlay muted playsInline aria-label={`${name} program preview`}
            style={{ aspectRatio: orientation === 'portrait' ? '9 / 16' : '16 / 9' }} />
          {isLive && <p role="status">{name} relay {stats.status === 'live' ? 'connected' : stats.status} · {Math.round(stats.bitrateKbps)} kbps upstream</p>}
        </>
      )}
    </section>
  );
}
