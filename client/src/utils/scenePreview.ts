import type { LayoutMode, LogoPlacement, Scene } from '@studio/shared';

export interface ScenePreviewTile {
  left: string;
  top: string;
  width: string;
  height: string;
  primary?: boolean;
  floating?: boolean;
}

export interface ScenePreviewOverlays {
  lowerThird: boolean;
  banner: boolean;
  ticker: boolean;
  timer: boolean;
  logo: boolean;
}

export function getScenePreviewTiles(layout: LayoutMode): ScenePreviewTile[] {
  switch (layout) {
    case 'single':
      return [{ left: '18%', top: '16%', width: '64%', height: '58%', primary: true }];
    case 'side-by-side':
      return [
        { left: '8%', top: '18%', width: '39%', height: '55%', primary: true },
        { left: '53%', top: '18%', width: '39%', height: '55%' },
      ];
    case 'spotlight':
      return [
        { left: '8%', top: '8%', width: '84%', height: '55%', primary: true },
        { left: '10%', top: '70%', width: '22%', height: '17%' },
        { left: '39%', top: '70%', width: '22%', height: '17%' },
        { left: '68%', top: '70%', width: '22%', height: '17%' },
      ];
    case 'pip':
      return [
        { left: '7%', top: '8%', width: '86%', height: '72%', primary: true },
        { left: '63%', top: '54%', width: '27%', height: '22%', floating: true },
      ];
    case 'featured':
      return [
        { left: '7%', top: '10%', width: '61%', height: '66%', primary: true },
        { left: '73%', top: '11%', width: '20%', height: '28%' },
        { left: '73%', top: '47%', width: '20%', height: '28%' },
      ];
    case 'grid':
      return [
        { left: '9%', top: '13%', width: '37%', height: '27%' },
        { left: '54%', top: '13%', width: '37%', height: '27%' },
        { left: '9%', top: '49%', width: '37%', height: '27%' },
        { left: '54%', top: '49%', width: '37%', height: '27%' },
      ];
    default:
      return assertNever(layout);
  }
}

export function getScenePreviewOverlays(scene: Pick<Scene, 'visibleOverlayIds' | 'logoUrl'>): ScenePreviewOverlays {
  return {
    lowerThird: scene.visibleOverlayIds.some((id) => id.startsWith('lt-')),
    banner: scene.visibleOverlayIds.some((id) => id.startsWith('banner-')),
    ticker: scene.visibleOverlayIds.some((id) => id.startsWith('ticker-')),
    timer: scene.visibleOverlayIds.some((id) => id.startsWith('timer-')),
    logo: Boolean(scene.logoUrl),
  };
}

export function getScenePreviewLogoPosition(placement: LogoPlacement | undefined): { top?: string; right?: string; bottom?: string; left?: string } {
  switch (placement) {
    case 'top-left':
      return { top: '8%', left: '8%' };
    case 'bottom-left':
      return { bottom: '14%', left: '8%' };
    case 'bottom-right':
      return { bottom: '14%', right: '8%' };
    case 'top-right':
    default:
      return { top: '8%', right: '8%' };
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled layout: ${value}`);
}
