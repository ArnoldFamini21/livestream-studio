import { useEffect, useRef, type CSSProperties, type RefObject } from 'react';
import type { BroadcastOrientation, CameraShape, NameTagStyle } from '@studio/shared';
import { useCompositor, type CompositorProps } from '../hooks/useCompositor.ts';
import { getSecondaryProgramRects, type ProgramTileRect, type SecondaryProgramLayout } from '../utils/dualOutput.ts';
import { VideoTile } from './VideoTile.tsx';

export interface SecondaryProgramSource {
  id: string;
  name: string;
  stream: MediaStream | null;
  isLocal: boolean;
  videoEnabled: boolean;
  isScreenShare?: boolean;
}

interface SecondaryProgramProps {
  composition: Omit<CompositorProps, 'containerRef' | 'isActive' | 'orientation'>;
  primaryStageRef: RefObject<HTMLDivElement>;
  orientation: BroadcastOrientation;
  layout: SecondaryProgramLayout;
  participants: SecondaryProgramSource[];
  screen?: SecondaryProgramSource;
  cameraShape?: CameraShape;
  nameTagStyle?: NameTagStyle;
  onStream: (stream: MediaStream | null) => void;
}

const SECONDARY_SIZES = {
  landscape: { width: 1280, height: 720 },
  portrait: { width: 720, height: 1280 },
};

function tileStyle(rect: ProgramTileRect): CSSProperties {
  return {
    position: 'absolute',
    left: `${rect.left * 100}%`,
    top: `${rect.top * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
    overflow: 'hidden',
    borderRadius: 8,
  };
}

export function SecondaryProgram({
  composition, primaryStageRef, orientation, layout, participants, screen, cameraShape, nameTagStyle, onStream,
}: SecondaryProgramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const size = SECONDARY_SIZES[orientation];
  const { compositeStreamRef } = useCompositor({
    ...composition,
    containerRef,
    mediaSourceRef: primaryStageRef,
    orientation,
    outputSize: size,
    isActive: true,
  });

  useEffect(() => {
    onStream(compositeStreamRef.current);
    return () => onStream(null);
  }, [compositeStreamRef, onStream]);

  // Shared material remains visible in each layout. Video and images are read
  // from the main stage, so a clip never starts a second playback.
  const hasContent = Boolean(composition.activeMedia || screen);
  const rects = getSecondaryProgramRects(orientation, layout, participants.length + Number(hasContent));
  const contentRect = hasContent ? rects[0] : null;
  const participantRects = hasContent ? rects.slice(1) : rects;
  const renderTile = (source: SecondaryProgramSource) => (
    <VideoTile
      participantId={source.id}
      stream={source.stream}
      name={source.name}
      isLocal={source.isLocal}
      isScreenShare={source.isScreenShare}
      audioEnabled={false}
      videoEnabled={source.videoEnabled}
      brandColor={composition.brandColor}
      cameraShape={cameraShape}
      nameTagStyle={nameTagStyle}
    />
  );

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      data-second-program-stage={orientation}
      style={{ position: 'fixed', left: -10_000, top: 0, width: size.width / 2, height: size.height / 2, pointerEvents: 'none' }}
    >
      {contentRect && (
        <div className="studio-active-media" style={tileStyle(contentRect)}>
          {!composition.activeMedia && screen ? renderTile(screen) : null}
        </div>
      )}
      {participantRects.map((rect, index) => {
        const participant = participants[index];
        return (
          <div key={participant.id} style={tileStyle(rect)} data-stage-item-id={participant.id}>
            {renderTile(participant)}
          </div>
        );
      })}
    </div>
  );
}
