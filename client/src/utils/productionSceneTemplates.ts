import type { CameraShape, LayoutMode, NameTagStyle, StageBackground } from '@studio/shared';
import type { LowerThirdAnimation, LowerThirdAnimationDirection, LowerThirdFont } from './lowerThirds.ts';
import { normalizeBrandColor } from './brandTheme.ts';

export type ProductionSceneTemplate =
  | 'starting-soon'
  | 'main-stage'
  | 'interview'
  | 'panel'
  | 'presentation'
  | 'live-q-and-a'
  | 'screen-share'
  | 'brb'
  | 'ending';

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

interface ProductionSceneLowerThird {
  name: string;
  title: string;
  style: 'minimal' | 'bold' | 'gradient' | 'glass';
  visible: boolean;
  durationSeconds?: number;
  accentColor?: string;
  animation?: LowerThirdAnimation;
  animationDirection?: LowerThirdAnimationDirection;
  fontFamily?: LowerThirdFont;
}

export interface ProductionSceneTemplateConfig {
  name: string;
  layout: LayoutMode;
  background: StageBackground;
  brandColor: string;
  cameraShape: CameraShape;
  nameTagStyle: NameTagStyle;
  lowerThird?: ProductionSceneLowerThird;
  banner?: ProductionSceneBanner;
  ticker?: ProductionSceneTicker;
  timer?: ProductionSceneTimer;
}

export interface ProductionSceneBrandProfile {
  brandColor?: string | null;
  background?: StageBackground | null;
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
    id: 'main-stage',
    name: 'Main Stage',
    layout: 'single',
    background: { type: 'gradient', value: 'linear-gradient(135deg, #0f172a 0%, #3730a3 54%, #0891b2 100%)' },
    accent: '#22d3ee',
  },
  {
    id: 'interview',
    name: 'Interview',
    layout: 'side-by-side',
    background: { type: 'gradient', value: 'linear-gradient(135deg, #111827 0%, #1e3a8a 52%, #0f766e 100%)' },
    accent: '#2dd4bf',
  },
  {
    id: 'panel',
    name: 'Panel',
    layout: 'grid',
    background: { type: 'gradient', value: 'linear-gradient(135deg, #111827 0%, #581c87 52%, #be185d 100%)' },
    accent: '#f472b6',
  },
  {
    id: 'presentation',
    name: 'Presentation',
    layout: 'pip',
    background: { type: 'gradient', value: 'linear-gradient(135deg, #0f172a 0%, #1e293b 52%, #0f766e 100%)' },
    accent: '#5eead4',
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

export const PRODUCTION_SCENE_PACK_TEMPLATE_IDS: readonly ProductionSceneTemplate[] = [
  'starting-soon',
  'main-stage',
  'interview',
  'panel',
  'presentation',
  'live-q-and-a',
  'screen-share',
  'brb',
  'ending',
];

export function getProductionScenePackTemplateIds(availableSlots: number): ProductionSceneTemplate[] {
  const safeSlots = Math.max(0, Math.floor(Number.isFinite(availableSlots) ? availableSlots : 0));
  return PRODUCTION_SCENE_PACK_TEMPLATE_IDS.slice(0, safeSlots);
}

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

function hasUsableBrandBackground(background: StageBackground | null | undefined): background is StageBackground {
  return Boolean(
    background &&
    background.type !== 'none' &&
    typeof background.value === 'string' &&
    background.value.trim()
  );
}

export function applyProductionSceneBrandProfile(
  config: ProductionSceneTemplateConfig,
  profile: ProductionSceneBrandProfile = {}
): ProductionSceneTemplateConfig {
  const brandColor = normalizeBrandColor(profile.brandColor, config.brandColor);
  const background = hasUsableBrandBackground(profile.background)
    ? profile.background
    : config.background;

  return {
    ...config,
    background,
    brandColor,
    lowerThird: config.lowerThird
      ? { ...config.lowerThird, accentColor: brandColor }
      : undefined,
    banner: config.banner
      ? {
          ...config.banner,
          ...(config.banner.style === 'custom' ? { customColor: brandColor } : {}),
        }
      : undefined,
  };
}

function getBaseProductionSceneTemplateConfig(template: ProductionSceneTemplate): ProductionSceneTemplateConfig {
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
    case 'main-stage':
      return {
        name: 'Main Stage',
        layout: 'single',
        background: { type: 'gradient', value: 'linear-gradient(135deg, #0f172a 0%, #3730a3 54%, #0891b2 100%)' },
        brandColor: '#22d3ee',
        cameraShape: 'rounded',
        nameTagStyle: 'classic',
        lowerThird: {
          name: 'Host',
          title: 'Live Host',
          style: 'glass',
          visible: true,
          durationSeconds: 12,
          accentColor: '#22d3ee',
          animation: 'slide',
          animationDirection: 'left',
          fontFamily: 'inter',
        },
        banner: {
          text: 'Live Now',
          visible: false,
          style: 'custom',
          customColor: '#0891b2',
          isTicker: false,
          position: 'top',
        },
        ticker: {
          text: 'Welcome to the live broadcast.',
          visible: false,
          speed: 'normal',
          backgroundColor: '#164e63',
          textColor: '#ecfeff',
          separator: '•',
        },
      };
    case 'interview':
      return {
        name: 'Interview',
        layout: 'side-by-side',
        background: { type: 'gradient', value: 'linear-gradient(135deg, #111827 0%, #1e3a8a 52%, #0f766e 100%)' },
        brandColor: '#2dd4bf',
        cameraShape: 'rounded',
        nameTagStyle: 'classic',
        lowerThird: {
          name: 'Guest Name',
          title: 'Interview Guest',
          style: 'bold',
          visible: true,
          durationSeconds: 15,
          accentColor: '#2dd4bf',
          animation: 'slide',
          animationDirection: 'left',
          fontFamily: 'inter',
        },
        banner: {
          text: 'Interview',
          visible: false,
          style: 'custom',
          customColor: '#0f766e',
          isTicker: false,
          position: 'top',
        },
        ticker: {
          text: 'Send your questions in chat for the interview segment.',
          visible: false,
          speed: 'normal',
          backgroundColor: '#134e4a',
          textColor: '#ccfbf1',
          separator: '•',
        },
      };
    case 'panel':
      return {
        name: 'Panel Discussion',
        layout: 'grid',
        background: { type: 'gradient', value: 'linear-gradient(135deg, #111827 0%, #581c87 52%, #be185d 100%)' },
        brandColor: '#f472b6',
        cameraShape: 'rounded',
        nameTagStyle: 'minimal',
        banner: {
          text: 'Panel Discussion',
          visible: true,
          style: 'custom',
          customColor: '#be185d',
          isTicker: false,
          position: 'top',
        },
        ticker: {
          text: 'Panel segment live. Add questions and comments in chat.',
          visible: true,
          speed: 'normal',
          backgroundColor: '#500724',
          textColor: '#fce7f3',
          separator: '•',
        },
      };
    case 'presentation':
      return {
        name: 'Presentation',
        layout: 'pip',
        background: { type: 'gradient', value: 'linear-gradient(135deg, #0f172a 0%, #1e293b 52%, #0f766e 100%)' },
        brandColor: '#5eead4',
        cameraShape: 'rounded',
        nameTagStyle: 'minimal',
        banner: {
          text: 'Presentation',
          visible: false,
          style: 'custom',
          customColor: '#0f766e',
          isTicker: false,
          position: 'top',
        },
        ticker: {
          text: 'Slides are on screen. Use the Media tab to start your deck.',
          visible: true,
          speed: 'slow',
          backgroundColor: '#134e4a',
          textColor: '#ccfbf1',
          separator: '•',
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

export function getProductionSceneTemplateConfig(
  template: ProductionSceneTemplate,
  profile: ProductionSceneBrandProfile = {}
): ProductionSceneTemplateConfig {
  return applyProductionSceneBrandProfile(getBaseProductionSceneTemplateConfig(template), profile);
}
