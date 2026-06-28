import type { CameraShape, LayoutMode, NameTagStyle, StageBackground } from '@studio/shared';

export type ProductionSceneTemplate = 'starting-soon' | 'brb' | 'ending' | 'live-q-and-a' | 'screen-share';

export interface ProductionSceneTemplateCard {
  id: ProductionSceneTemplate;
  name: string;
  layout: LayoutMode;
  background: StageBackground;
  accent: string;
}

interface ProductionSceneBanner {
  text: string;
  style: 'breaking' | 'info' | 'alert' | 'custom';
  customColor?: string;
  isTicker: boolean;
  position: 'top' | 'bottom';
  visible: boolean;
  durationSeconds?: number;
}

interface ProductionSceneTicker {
  text: string;
  speed: 'slow' | 'normal' | 'fast';
  backgroundColor: string;
  textColor: string;
  visible: boolean;
  separator: string;
}

interface ProductionSceneTimer {
  mode: 'countdown' | 'countup';
  durationSeconds: number;
  remainingSeconds: number;
  isRunning: boolean;
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  style: 'minimal' | 'bold' | 'neon';
  visible: boolean;
}

export interface ProductionSceneTemplateConfig {
  name: string;
  layout: LayoutMode;
  background: StageBackground;
  brandColor: string;
  cameraShape: CameraShape;
  nameTagStyle: NameTagStyle;
  banner?: ProductionSceneBanner;
  ticker?: ProductionSceneTicker;
  timer?: ProductionSceneTimer;
}

export const PRODUCTION_SCENE_TEMPLATE_CARDS: ProductionSceneTemplateCard[] = [
  {
    id: 'starting-soon',
    name: 'Starting Soon',
    layout: 'single',
    background: { type: 'gradient', value: 'linear-gradient(135deg, #111827 0%, #312e81 55%, #0e7490 100%)' },
    accent: '#67e8f9',
  },
  {
    id: 'live-q-and-a',
    name: 'Live Q&A',
    layout: 'featured',
    background: { type: 'gradient', value: 'linear-gradient(135deg, #0f172a 0%, #1d4ed8 58%, #312e81 100%)' },
    accent: '#60a5fa',
  },
  {
    id: 'screen-share',
    name: 'Screen Share',
    layout: 'pip',
    background: { type: 'gradient', value: 'linear-gradient(135deg, #111827 0%, #334155 55%, #0369a1 100%)' },
    accent: '#38bdf8',
  },
  {
    id: 'brb',
    name: 'BRB',
    layout: 'single',
    background: { type: 'gradient', value: 'linear-gradient(135deg, #111827 0%, #14532d 58%, #065f46 100%)' },
    accent: '#34d399',
  },
  {
    id: 'ending',
    name: 'Ending',
    layout: 'single',
    background: { type: 'gradient', value: 'linear-gradient(135deg, #111827 0%, #7f1d1d 58%, #991b1b 100%)' },
    accent: '#f87171',
  },
];

export function getBackgroundPreview(bg: StageBackground): string {
  switch (bg.type) {
    case 'color':
      return bg.value;
    case 'gradient':
      return bg.value;
    case 'image':
      return `url(${bg.value}) center/cover no-repeat`;
    case 'video':
      return 'linear-gradient(135deg, #111827 0%, #334155 100%)';
    case 'none':
    default:
      return '#09090b';
  }
}

export function getProductionSceneTemplateConfig(template: ProductionSceneTemplate): ProductionSceneTemplateConfig {
  switch (template) {
    case 'starting-soon':
      return {
        name: 'Starting Soon',
        layout: 'single',
        background: { type: 'gradient', value: 'linear-gradient(135deg, #111827 0%, #312e81 55%, #0e7490 100%)' },
        brandColor: '#67e8f9',
        cameraShape: 'rounded',
        nameTagStyle: 'minimal',
        banner: {
          text: 'Starting Soon',
          visible: true,
          style: 'custom',
          customColor: '#0e7490',
          isTicker: false,
          position: 'top',
        },
        ticker: {
          text: 'Welcome. The live broadcast will begin shortly.',
          visible: true,
          speed: 'normal',
          backgroundColor: '#0f172a',
          textColor: '#e0f2fe',
          separator: '•',
        },
        timer: {
          mode: 'countdown',
          durationSeconds: 300,
          remainingSeconds: 300,
          isRunning: false,
          visible: true,
          position: 'top-right',
          style: 'bold',
        },
      };
    case 'live-q-and-a':
      return {
        name: 'Live Q&A',
        layout: 'featured',
        background: { type: 'gradient', value: 'linear-gradient(135deg, #0f172a 0%, #1d4ed8 58%, #312e81 100%)' },
        brandColor: '#60a5fa',
        cameraShape: 'rounded',
        nameTagStyle: 'classic',
        banner: {
          text: 'Live Q&A',
          visible: true,
          style: 'custom',
          customColor: '#2563eb',
          isTicker: false,
          position: 'top',
        },
        ticker: {
          text: 'Drop your questions in chat. The host will feature selected questions on screen.',
          visible: true,
          speed: 'normal',
          backgroundColor: '#172554',
          textColor: '#dbeafe',
          separator: '•',
        },
      };
    case 'screen-share':
      return {
        name: 'Screen Share',
        layout: 'pip',
        background: { type: 'gradient', value: 'linear-gradient(135deg, #111827 0%, #334155 55%, #0369a1 100%)' },
        brandColor: '#38bdf8',
        cameraShape: 'rounded',
        nameTagStyle: 'minimal',
        banner: {
          text: 'Screen Share',
          visible: true,
          style: 'custom',
          customColor: '#0369a1',
          isTicker: false,
          position: 'top',
        },
        ticker: {
          text: 'Follow along with the shared screen. Questions can go in chat.',
          visible: true,
          speed: 'slow',
          backgroundColor: '#082f49',
          textColor: '#e0f2fe',
          separator: '•',
        },
      };
    case 'brb':
      return {
        name: 'Be Right Back',
        layout: 'single',
        background: { type: 'gradient', value: 'linear-gradient(135deg, #111827 0%, #14532d 58%, #065f46 100%)' },
        brandColor: '#34d399',
        cameraShape: 'rounded',
        nameTagStyle: 'minimal',
        banner: {
          text: 'Be Right Back',
          visible: true,
          style: 'custom',
          customColor: '#059669',
          isTicker: false,
          position: 'top',
        },
        ticker: {
          text: 'We will be back in a moment.',
          visible: true,
          speed: 'slow',
          backgroundColor: '#052e16',
          textColor: '#bbf7d0',
          separator: '•',
        },
      };
    case 'ending':
      return {
        name: 'Ending',
        layout: 'single',
        background: { type: 'gradient', value: 'linear-gradient(135deg, #111827 0%, #7f1d1d 58%, #991b1b 100%)' },
        brandColor: '#f87171',
        cameraShape: 'rounded',
        nameTagStyle: 'block',
        banner: {
          text: 'Thanks for watching',
          visible: true,
          style: 'custom',
          customColor: '#dc2626',
          isTicker: false,
          position: 'top',
        },
        ticker: {
          text: 'Follow the host for the next live session.',
          visible: true,
          speed: 'normal',
          backgroundColor: '#450a0a',
          textColor: '#fee2e2',
          separator: '•',
        },
      };
  }
}
