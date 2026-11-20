import QRCode from 'qrcode';

const QUIET_ZONE_MODULES = 4;
const MODULE_SIZE = 8;

/** Rasterize once per link. The clear border keeps the code readable over any stage. */
export function createOverlayQrCanvas(url: string): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  try {
    const { modules } = QRCode.create(url, { errorCorrectionLevel: 'M' });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = (modules.size + QUIET_ZONE_MODULES * 2) * MODULE_SIZE;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000';
    for (let y = 0; y < modules.size; y += 1) {
      for (let x = 0; x < modules.size; x += 1) {
        if (modules.get(y, x)) {
          context.fillRect((x + QUIET_ZONE_MODULES) * MODULE_SIZE, (y + QUIET_ZONE_MODULES) * MODULE_SIZE, MODULE_SIZE, MODULE_SIZE);
        }
      }
    }
    return canvas;
  } catch {
    return null;
  }
}

export function fitOverlayQr(
  rect: { x: number; y: number; width: number; height: number },
  position: string,
) {
  const size = Math.min(rect.width, rect.height);
  const x = position.endsWith('left') ? rect.x : position.endsWith('right')
    ? rect.x + rect.width - size : rect.x + (rect.width - size) / 2;
  const y = position.startsWith('top') ? rect.y : position.startsWith('bottom')
    ? rect.y + rect.height - size : rect.y + (rect.height - size) / 2;
  return { x, y, size };
}
