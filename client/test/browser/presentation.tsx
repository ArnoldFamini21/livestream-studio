// Browser regression uses production controls and geometry with generated media.
// Open with Vite and use Run presentation regression; no webcam or network needed.
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ActiveMedia, LayoutMode, StudioMediaAsset } from '@studio/shared';
import { StageCanvas } from '../../src/components/StageCanvas.tsx';
import { useCompositor } from '../../src/hooks/useCompositor.ts';
import { VideoTile } from '../../src/components/VideoTile.tsx';
import { LayoutSwitcher } from '../../src/components/LayoutSwitcher.tsx';
import { PresentationToolbar } from '../../src/components/PresentationToolbar.tsx';
import { MediaLibrary } from '../../src/components/MediaLibrary.tsx';
import { getPresentationLayout, type PresentationCameraSize, type PresentationCorner } from '../../src/utils/presentationLayout.ts';
import { splitScreenShareStageItems } from '../../src/utils/mediaShareLayouts.ts';
import { getPresentationShortcut } from '../../src/utils/presentationShortcuts.ts';
import { getNextPresentationSlideIndex } from '../../src/utils/presentationDeckControls.ts';
import '../../src/styles/global.css';
import '../../src/styles/studio-chrome.css';
import '../../src/styles/media-library.css';

function slideImage(title: string, number: number) {
  const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f4f2f9'; ctx.fillRect(0, 0, 1280, 720);
  ctx.strokeStyle = '#7962b5'; ctx.lineWidth = 4; ctx.strokeRect(48, 48, 1184, 624);
  ctx.fillStyle = '#7e65b5'; ctx.font = '22px Arial'; ctx.fillText(`LIVE STREAM STUDIO / ${number}`, 96, 150);
  ctx.fillStyle = '#262237'; ctx.font = '68px Arial'; ctx.fillText(title, 96, 360);
  ctx.fillStyle = '#686273'; ctx.font = '26px Arial'; ctx.fillText('A clear view. A better conversation.', 96, 430);
  ctx.fillStyle = '#ab92e1'; ctx.beginPath(); ctx.arc(1110, 560, 64, 0, Math.PI * 2); ctx.fill();
  return canvas.toDataURL('image/png');
}

const deck: ActiveMedia = {
  assetId: 'deck', name: 'The conversation.pptx', type: 'presentation', url: 'fixture:deck',
  preview: { kind: 'presentation-slides', sourceFormat: 'pptx', slides: ['Opening', 'The conversation', 'Thank you'].map((title, index) => ({ id: `slide-${index}`, title, lines: [], notes: [`Private note for slide ${index + 1}. Ask the guest a question.`], rendered: true, imageUrl: slideImage(title, index + 1) })) },
};
const assets: StudioMediaAsset[] = [
  { id: 'deck', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', name: deck.name, type: 'presentation', url: deck.url, source: 'upload', createdAt: new Date().toISOString(), preview: deck.preview, processingStatus: 'ready' },
  { id: 'pdf', mimeType: 'application/pdf', name: 'Handout.pdf', type: 'pdf', url: 'fixture:pdf', source: 'upload', createdAt: new Date().toISOString(), preview: { ...deck.preview!, sourceFormat: 'pdf' }, processingStatus: 'ready' },
];
function Fixture() {
  const [media, setMedia] = useState<ActiveMedia | null>(deck);
  const [slide, setSlide] = useState(0);
  const [layout, setLayout] = useState<LayoutMode>('grid');
  const [size, setSize] = useState<PresentationCameraSize>('medium');
  const [corner, setCorner] = useState<PresentationCorner>('BR');
  const [selectedScreen, setSelectedScreen] = useState('host-screen');
  const [guestSharing, setGuestSharing] = useState(true);
  const [width, setWidth] = useState(1180);
  const [camera, setCamera] = useState<MediaStream | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const { compositeCanvasRef } = useCompositor({ containerRef: stageRef, isActive: true, banners: [], lowerThirds: [], timers: [], tickers: [], activeMedia: media, activeMediaSlideIndex: slide });
  useEffect(() => {
    const canvas = compositeCanvasRef.current;
    if (!canvas || !outputRef.current) return;
    canvas.id = 'broadcast-output'; canvas.style.width = 'min(100%, 480px)'; canvas.style.height = 'auto';
    canvas.setAttribute('aria-label', 'Actual broadcast output');
    outputRef.current.appendChild(canvas);
    return () => canvas.remove();
  }, [compositeCanvasRef]);
  useEffect(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#332c4c'; ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = '#a998d2'; ctx.beginPath(); ctx.arc(640, 300, 120, 0, Math.PI * 2); ctx.fill();
    ctx.font = '40px Arial'; ctx.fillStyle = '#eeeaf6'; ctx.fillText('Generated presenter', 450, 540);
    const stream = canvas.captureStream(15); setCamera(stream);
    const timer = window.setInterval(() => ctx.fillRect(0, 0, 2, 2), 70);
    return () => { clearInterval(timer); stream.getTracks().forEach(track => track.stop()); };
  }, []);
  useEffect(() => {
    if (!media?.preview) return;
    const handle = (event: KeyboardEvent) => {
      const direction = getPresentationShortcut(event); if (!direction) return;
      event.preventDefault(); setSlide(index => getNextPresentationSlideIndex(index, media.preview!.slides.length, direction));
    };
    window.addEventListener('keydown', handle); return () => window.removeEventListener('keydown', handle);
  }, [media]);
  const split = splitScreenShareStageItems([
    { id: 'host-screen', name: 'Your screen', isScreenShare: true },
    ...(guestSharing ? [{ id: 'guest-screen', name: 'Guest’s screen', isScreenShare: true }] : []),
  ], selectedScreen);
  const selected = split.screenShareItem!;
  const composition = getPresentationLayout(layout, 4, corner, size);
  return <>
    <div className="fixture-controls"><button id="test-slides" onClick={() => { setMedia(deck); setSlide(0); }}>Sample slides</button><button id="test-screens" onClick={() => setMedia(null)}>Two shared screens</button><button id="end-guest" onClick={() => setGuestSharing(false)}>End guest share</button><button id="test-narrow" onClick={() => setWidth(value => value === 1180 ? 640 : 1180)}>Toggle panel width</button></div>
    <div id="fixture" className="studio-container" style={{ width }}>
      <div className="test-stage"><h1>Stage preview</h1>
        <StageCanvas stageRef={stageRef} style={{ background: '#111116' }} footer={<PresentationToolbar media={media} slideIndex={slide} onSlideIndexChange={setSlide} screenName={selected.name} screens={split.screenShareItems} selectedScreenId={selected.id} onScreenChange={setSelectedScreen} canStopScreen={selected.id === 'host-screen'} onStop={() => setMedia(null)} />}>
          <div className="studio-active-media" style={composition.mediaStyle}>
            <img id="on-stage-image" alt={media ? media.preview!.slides[slide].title : selected.name} src={media ? media.preview!.slides[slide].imageUrl : slideImage(selected.name, 1)} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          </div>
          {composition.participantStyles.map((style, index) => <div key={index} className="presenter-tile" style={style}><VideoTile stream={camera} name={index ? `Guest ${index}` : 'You'} isLocal audioEnabled={false} /></div>)}
        </StageCanvas>
        <div className="studio-layoutBar"><LayoutSwitcher currentLayout={layout} onLayoutChange={setLayout} participantCount={5} mediaParticipantCount={4} isMediaActive pipCorner={corner} onPipCornerChange={setCorner} cameraSize={size} onCameraSizeChange={setSize} /></div>
      </div>
      <aside><MediaLibrary assets={assets} activeMedia={media} activeMediaSlideIndex={slide} onActiveMediaSlideIndexChange={setSlide} onUpload={() => {}} onAddUrl={() => {}} onRemove={() => {}} onStop={() => setMedia(null)} onPlay={asset => { setMedia({ ...asset, assetId: asset.id }); setSlide(0); }} /></aside>
    </div>
    <div ref={outputRef} style={{ padding: 20 }}>Actual broadcast output (1920 × 1080):<br /></div>
  </>;
}
const root = createRoot(document.getElementById('root')!);
flushSync(() => root.render(<Fixture />));
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); };
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const element = <T extends HTMLElement = HTMLElement>(selector: string) => { const el = document.querySelector<T>(selector); if (!el) throw new Error(`Missing ${selector}`); return el; };
const click = async (selector: string) => { element(selector).click(); await settle(); };
const select = async (selector: string, value: string) => { const el = element<HTMLSelectElement>(selector); el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); await settle(); };
const outputFingerprint = () => {
  const source = element<HTMLCanvasElement>('#broadcast-output');
  check(source.width === 1920 && source.height === 1080, 'Broadcast output size changed');
  const sample = document.createElement('canvas'); sample.width = 96; sample.height = 54;
  const ctx = sample.getContext('2d')!; ctx.drawImage(source, 0, 0, 96, 54);
  return sample.toDataURL();
};
const stageTitle = () => element<HTMLImageElement>('#on-stage-image').alt;
const assertFrame = () => {
  const canvas = element('.studio-canvas'); const box = canvas.getBoundingClientRect();
  check(canvas.offsetWidth === 960 && canvas.offsetHeight === 540, 'Broadcast dimensions changed');
  check(Math.abs(box.width / box.height - 16 / 9) < .001, 'Preview stretched');
  check(getComputedStyle(element('#on-stage-image')).objectFit === 'contain', 'Shared file cropped');
  check(!canvas.querySelector('dialog, .presentation-picker-notes, .presentation-toolbar'), 'Private controls entered broadcast');
  for (const tile of document.querySelectorAll<HTMLElement>('.presenter-tile')) {
    check(tile.offsetLeft >= 0 && tile.offsetTop >= 0 && tile.offsetLeft + tile.offsetWidth <= 961 && tile.offsetTop + tile.offsetHeight <= 541, 'Presenter clipped');
  }
};
document.getElementById('run')!.onclick = async () => {
  const button = element<HTMLButtonElement>('#run'); button.disabled = true;
  const result = element('#result'); let checks = 0;
  try {
    // Remount for a repeatable run after manual inspection.
    flushSync(() => root.render(<Fixture key={Date.now()} />)); await settle();
    await document.fonts.ready;
    await element<HTMLImageElement>('#on-stage-image').decode(); await settle();
    assertFrame(); checks++;
    const originalOutput = outputFingerprint();
    const trigger = element<HTMLButtonElement>('.presentation-slide-picker-trigger'); trigger.focus();
    await click('.presentation-slide-picker-trigger');
    check(element<HTMLDialogElement>('dialog').open, 'Picker is not modal');
    await click('[aria-label^="Preview slide 3:"]');
    check(stageTitle() === 'Opening', 'Private cue leaked onto stage'); assertFrame();
    check(outputFingerprint() === originalOutput, 'Private preview changed broadcast pixels'); checks++;
    element('[aria-label^="Preview slide 3:"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })); await settle();
    check(stageTitle() === 'Opening' && element('.presentation-picker-show').textContent === 'Show slide 2', 'Private keyboard navigation changed stage'); checks++;
    await click('.presentation-picker-show'); check(stageTitle() === 'The conversation', 'Show did not publish selected slide');
    check(outputFingerprint() !== originalOutput, 'Published slide did not reach broadcast output'); checks++;
    element<HTMLDialogElement>('dialog').close(); await settle();
    check(document.activeElement === trigger, 'Focus not restored'); checks++;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); await settle();
    check(stageTitle() === 'Thank you', 'Stage keyboard navigation failed'); checks++;
    await click('[aria-label="Preview The conversation.pptx"]');
    await click('[aria-label="Preview next slide"]');
    check(stageTitle() === 'Thank you', 'Library cue leaked onto stage');
    await click('.media-preview-view .media-primary'); check(stageTitle() === 'The conversation', 'Active library deck could not publish cue'); checks++;
    await click('[aria-label="Show Handout.pdf"]');
    await click('.presentation-slide-picker-trigger'); check(element('.presentation-picker-caption').textContent?.includes('Page 1 of 3'), 'PDF page controls missing');
    await click('[aria-label^="Preview page 3:"]'); await click('.presentation-picker-show'); check(stageTitle() === 'Thank you', 'PDF page not published');
    element<HTMLDialogElement>('dialog').close(); await settle(); checks++;
    await click('#test-screens'); await select('[aria-label="Screen on stage"]', 'guest-screen');
    check(stageTitle() === 'Guest’s screen', 'Selected guest screen not on stage');
    check(!document.querySelector('.presentation-stop'), 'Stop button would stop hidden local share'); checks++;
    await click('#end-guest'); check(stageTitle() === 'Your screen', 'Ended guest share did not fall back');
    check(!document.querySelector('[aria-label="Screen on stage"]'), 'Single screen has unnecessary selector'); checks++;
    await click('#test-slides');
    for (const mode of ['single', 'grid', 'spotlight', 'pip', 'side-by-side', 'featured']) {
      if (mode === 'side-by-side' || mode === 'featured') await select('[aria-label="More presentation layouts"]', mode);
      else { const buttons = [...document.querySelectorAll<HTMLButtonElement>('.presentation-layout-options button')]; const index = ['single','grid','spotlight','pip'].indexOf(mode); buttons[index].click(); await settle(); }
      if (mode !== 'single') {
        element<HTMLDetailsElement>('.presentation-layout-settings').open = true;
        for (const size of ['small', 'medium', 'large']) {
          await select('.presentation-layout-settings-body label:first-child select', size);
          assertFrame(); checks++;
          if (mode === 'pip' || mode === 'featured') for (const corner of ['TL', 'TR', 'BL', 'BR']) {
            await select('.presentation-layout-settings-body label:last-child select', corner); assertFrame(); checks++;
          }
        }
      }
      await click('#test-narrow'); assertFrame(); checks++; await click('#test-narrow'); assertFrame(); checks++;
    }
    // Return to the most useful default view for visual inspection.
    const beside = document.querySelectorAll<HTMLButtonElement>('.presentation-layout-options button')[1]; beside.click(); await settle();
    await select('.presentation-layout-settings-body select', 'medium'); element<HTMLDetailsElement>('.presentation-layout-settings').open = false;
    result.textContent = `PASS: ${checks} browser checks.\nPrivate slide/PDF cueing, broadcast pixel isolation and publishing, keyboard and focus, screen selection/fallback, local-stop safety, presenter sizes/corners, panel-width changes, fixed canvas.`;
  } catch (error) { result.textContent = `FAIL after ${checks} checks: ${String(error)}`; }
  finally { button.disabled = false; }
};
