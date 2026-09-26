import { getParticipantAvatarColors } from './participantAvatar.ts';

/** Draw only visible participant decoration, using the stage's measured geometry. */
export function drawParticipantCards(
  ctx: CanvasRenderingContext2D,
  stage: HTMLElement,
  bounds: DOMRect,
  scaleX: number,
  scaleY: number,
  logicalScaleX: number,
  logicalScaleY: number,
) {
  const rect = (node: Element) => {
    const value = node.getBoundingClientRect();
    return { x: (value.left - bounds.left) * scaleX, y: (value.top - bounds.top) * scaleY, width: value.width * scaleX, height: value.height * scaleY };
  };
  // Parts of the stage marked data-local-only (the "(You)" on your own tile)
  // are for the studio view; the broadcast leaves them out.
  const localOnlyWidth = (node: Element) => Array.from(node.querySelectorAll?.('[data-local-only]') ?? [])
    .reduce((width, part) => width + rect(part).width, 0);
  const broadcastText = (node: Node): string => {
    const children = node.childNodes;
    if (!children || children.length === 0) return node.textContent || '';
    return Array.from(children)
      .map((child) => {
        const element = child as Element;
        if (typeof element.hasAttribute === 'function') {
          return element.hasAttribute('data-local-only') ? '' : broadcastText(element);
        }
        return child.textContent || '';
      })
      .join('');
  };
  const roundPath = (node: Element, trimRight = 0) => {
    const r = rect(node);
    r.width = Math.max(0, r.width - trimRight);
    const radius = getComputedStyle(node).borderTopLeftRadius;
    const size = radius.endsWith('%') ? Math.min(r.width, r.height) * parseFloat(radius) / 100 : parseFloat(radius) * Math.min(logicalScaleX, logicalScaleY);
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.width, r.height, Math.max(0, size || 0));
    return r;
  };
  const drawText = (node: Element) => {
    const r = rect(node);
    const style = getComputedStyle(node);
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.width, r.height);
    ctx.clip();
    ctx.fillStyle = style.color;
    ctx.font = `${style.fontWeight} ${parseFloat(style.fontSize) * logicalScaleY}px ${style.fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(broadcastText(node).trimEnd(), r.x, r.y + r.height / 2);
    ctx.restore();
  };

  stage.querySelectorAll<HTMLElement>('[data-stage-participant]').forEach(tile => {
    const tileRect = rect(tile);
    if (tileRect.width <= 0 || tileRect.height <= 0) return;
    ctx.save();
    roundPath(tile);
    ctx.clip();
    const placeholder = tile.querySelector<HTMLElement>('[data-stage-placeholder]');
    if (placeholder) {
      const r = rect(placeholder);
      const [start, end] = getParticipantAvatarColors(placeholder.dataset.stagePlaceholder || '');
      const gradient = ctx.createLinearGradient(r.x, r.y, r.x + r.width, r.y + r.height);
      gradient.addColorStop(0, start);
      gradient.addColorStop(1, end);
      ctx.fillStyle = gradient;
      ctx.fillRect(r.x, r.y, r.width, r.height);
      placeholder.querySelectorAll('[data-stage-avatar-circle]').forEach(circle => {
        const style = getComputedStyle(circle);
        roundPath(circle);
        ctx.fillStyle = style.backgroundColor;
        ctx.fill();
        if (parseFloat(style.borderTopWidth) > 0) {
          ctx.strokeStyle = style.borderTopColor;
          ctx.lineWidth = parseFloat(style.borderTopWidth) * logicalScaleX;
          ctx.stroke();
        }
      });
      placeholder.querySelectorAll('[data-stage-avatar-text]').forEach(drawText);
    }
    const tag = tile.querySelector('[data-stage-name-tag]');
    if (tag) {
      roundPath(tag, localOnlyWidth(tag));
      ctx.fillStyle = getComputedStyle(tag).backgroundColor;
      ctx.fill();
      const text = tag.querySelector('[data-stage-name-text]');
      if (text) drawText(text);
    }
    ctx.restore();
  });
}
