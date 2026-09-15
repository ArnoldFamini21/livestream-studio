// Open /test/browser/stage-canvas.html with Vite running. Uses the real component
// and production styles so CSS/layout regressions aren't hidden by a DOM mock.
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { StageCanvas } from '../../src/components/StageCanvas.tsx';
import { VideoTile } from '../../src/components/VideoTile.tsx';
import '../../src/styles/global.css';
import '../../src/styles/studio-chrome.css';

type Scenario = { width: number; height: number; footer?: boolean; oversized?: boolean };
const root = createRoot(document.getElementById('root')!);
const output = document.getElementById('result')!;
function Fixture({ width, height, footer, oversized }: Scenario) {
  const ref = useRef<HTMLDivElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const camera = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    // A generated camera exercises real video metadata without using a webcam.
    const source = document.createElement('canvas');
    source.width = 1280; source.height = 720;
    camera.current = source;
    const context = source.getContext('2d')!;
    const video = source.captureStream(15);
    setStream(video);
    let request = 0;
    const draw = () => {
      context.fillStyle = '#171723'; context.fillRect(0, 0, source.width, source.height);
      context.beginPath(); context.arc(source.width / 2, source.height / 2, 100, 0, Math.PI * 2);
      context.fillStyle = '#58cbaa'; context.fill();
      request = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(request); video.getTracks().forEach(track => track.stop()); camera.current = null; };
  }, []);
  useEffect(() => {
    if (camera.current) {
      camera.current.width = width < 400 ? 720 : oversized ? 1920 : 1280;
      camera.current.height = width < 400 ? 1280 : oversized ? 1080 : 720;
    }
  }, [width, oversized]);
  return <div id="fixture" style={{ width, height, display: 'flex', flexDirection: 'column' }}>
    <StageCanvas stageRef={ref} style={{ background: '#151521', borderRadius: 10 }}
      footer={footer && <div style={{ height: 48 }}>Slide 1 of 3 · Presentation controls</div>}>
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
        <div style={{ width: oversized ? 4000 : '100%', height: oversized ? 2000 : '100%' }} />
      </div>
      <VideoTile stream={stream} name="Generated camera" isLocal audioEnabled={false} />
      <div className="marker" style={{ left: 40, top: 40 }} />
      <div className="marker" style={{ right: 40, bottom: 40 }} />
      <span style={{ position: 'absolute', left: 160, top: 60, color: 'white' }}>Fixed 16:9 broadcast</span>
    </StageCanvas>
  </div>;
}
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function settle() { await nextFrame(); await nextFrame(); await nextFrame(); }
const near = (a: number, b: number, message: string) => {
  if (Math.abs(a - b) > 0.1) throw new Error(`${message}: ${a} vs ${b}`);
};
function measure({ width, height, footer }: Scenario) {
  const stage = document.querySelector<HTMLElement>('.studio-canvas')!;
  const viewport = document.querySelector<HTMLElement>('.studio-canvasWrapper')!;
  const visible = document.querySelector<HTMLElement>('.studio-preview-frame')!;
  const bounds = stage.getBoundingClientRect();
  const frame = visible.getBoundingClientRect();
  const area = viewport.getBoundingClientRect();
  const expectedScale = Math.min(Math.min(width, 1600) / 960, (height - (footer ? 48 : 0)) / 540);
  near(stage.offsetWidth, 960, 'Broadcast width');
  near(stage.offsetHeight, 540, 'Broadcast height');
  near(bounds.width, 960 * expectedScale, 'Preview width');
  near(bounds.height, 540 * expectedScale, 'Preview height');
  near(bounds.width / bounds.height, 16 / 9, 'Preview aspect ratio');
  near(bounds.x, frame.x, 'Frame left'); near(bounds.y, frame.y, 'Frame top');
  near(bounds.width, frame.width, 'Frame width'); near(bounds.height, frame.height, 'Frame height');
  near(bounds.x + bounds.width / 2, area.x + area.width / 2, 'Centered horizontally');
  if (bounds.x < area.x - 0.1 || bounds.y < area.y - 0.1 || bounds.right > area.right + 0.1 || bounds.bottom > area.bottom + 0.1) {
    throw new Error('Broadcast clipped by viewport');
  }
  for (const marker of document.querySelectorAll('.marker')) {
    const circle = marker.getBoundingClientRect();
    near(circle.width, circle.height, 'Circular reference must not stretch');
  }
  const video = stage.querySelector('video');
  if (!video || getComputedStyle(video).objectFit !== 'contain') throw new Error('Camera frame is being cropped or stretched');
  if (footer) {
    const controls = document.querySelector('.studio-canvas-footer')!.getBoundingClientRect();
    near(controls.y, bounds.bottom, 'Controls below broadcast');
    near(controls.width, bounds.width, 'Controls width');
    if (controls.bottom > area.bottom + 0.1) throw new Error('Controls clipped');
  }
  return { width: bounds.width, height: bounds.height };
}
const scenarios: Scenario[] = [
  { width: 1304, height: 540 }, { width: 984, height: 540 },
  { width: 984, height: 540, footer: true }, { width: 1304, height: 540, footer: true },
  { width: 360, height: 640 }, { width: 1365.5, height: 499.25 },
  { width: 1920, height: 1080 }, { width: 390, height: 180, footer: true },
  { width: 1304, height: 540, oversized: true },
];
flushSync(() => root.render(<Fixture {...scenarios[0]} />));
document.getElementById('run')!.onclick = async () => {
  const button = document.getElementById('run') as HTMLButtonElement;
  button.disabled = true;
  let checked = 0;
  try {
    for (let cycle = 0; cycle < 10; cycle++) {
      for (const scenario of scenarios) {
        flushSync(() => root.render(<Fixture {...scenario} />));
        await settle(); measure(scenario); checked++;
      }
      // Display:none or zero-size transitions must not poison the next size.
      flushSync(() => root.render(<Fixture width={0} height={0} />));
      await settle();
    }
    flushSync(() => root.render(<Fixture {...scenarios[0]} />));
    await settle();
    const first = measure(scenarios[0]);
    for (let i = 0; i < 180; i++) {
      await nextFrame();
      const current = measure(scenarios[0]);
      near(current.width, first.width, 'Idle width drift'); near(current.height, first.height, 'Idle height drift');
      checked++;
    }
    const video = document.querySelector('video')!;
    if (video.readyState < 2 || video.videoWidth === 0) throw new Error('Generated camera did not render');
    output.textContent = `PASS: ${checked} rendered-frame checks.\nPanel widths, short/mobile/fractional viewports, presentation controls, oversized content, changing camera resolution, zero-size recovery and idle stability.\nFinal canvas: ${first.width} × ${first.height} (16:9). Video: ${video.videoWidth} × ${video.videoHeight}.`;
  } catch (error) {
    output.textContent = `FAIL after ${checked} checks: ${String(error)}`;
  } finally { button.disabled = false; }
};
