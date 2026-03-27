import { useEffect, useRef, useCallback } from 'react';

interface CompositorProps {
  containerRef: React.RefObject<HTMLDivElement>;
  isLive: boolean;
  banners: any[];
  lowerThirds: any[];
  tickers: any[];
  brandColor?: string;
  logoUrl?: string | null;
}

export function useCompositor({
  containerRef,
  isLive,
  banners,
  lowerThirds,
  tickers,
  brandColor = '#3b82f6',
  logoUrl,
}: CompositorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositeStreamRef = useRef<MediaStream | null>(null);
  const rAF = useRef<number>(0);
  const logoImageRef = useRef<HTMLImageElement | null>(null);

  // Preload logo
  useEffect(() => {
    if (logoUrl) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = logoUrl;
      img.onload = () => { logoImageRef.current = img; };
    } else {
      logoImageRef.current = null;
    }
  }, [logoUrl]);

  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    canvasRef.current = canvas;
    
    // Capture the canvas video stream at 30 fps
    try {
      compositeStreamRef.current = canvas.captureStream(30);
    } catch (err) {
      console.warn('captureStream not supported in this environment');
    }

    return () => {
      cancelAnimationFrame(rAF.current);
    };
  }, []);

  const drawLoop = useCallback(() => {
    if (!canvasRef.current || !containerRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    // 1. Clear & Background
    ctx.fillStyle = '#0f172a'; // matches slate-900 background
    ctx.fillRect(0, 0, 1920, 1080);

    const containerBounds = containerRef.current.getBoundingClientRect();
    if (containerBounds.width === 0 || containerBounds.height === 0) {
      rAF.current = requestAnimationFrame(drawLoop);
      return;
    }
    
    const scaleX = 1920 / containerBounds.width;
    const scaleY = 1080 / containerBounds.height;

    // 2. Draw Videos mapped precisely from DOM coordinates
    const videos = containerRef.current.querySelectorAll('video');
    videos.forEach((video) => {
      const rect = video.getBoundingClientRect();
      const x = (rect.left - containerBounds.left) * scaleX;
      const y = (rect.top - containerBounds.top) * scaleY;
      const w = rect.width * scaleX;
      const h = rect.height * scaleY;

      if (video.readyState >= 2) {
        // Draw the local/remote video frame
        ctx.drawImage(video, x, y, w, h);
      }
      
      // Attempt to draw name tags for each participant tile
      const tileNode = video.closest('.participant-tile');
      if (tileNode) {
        const nameTag = tileNode.querySelector('.name-tag') as HTMLElement;
        if (nameTag) {
          const tagRect = nameTag.getBoundingClientRect();
          const tx = (tagRect.left - containerBounds.left) * scaleX;
          const ty = (tagRect.top - containerBounds.top) * scaleY;
          const tw = tagRect.width * scaleX;
          const th = tagRect.height * scaleY;
          
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.beginPath();
          ctx.roundRect(tx, ty, tw, th, 6 * scaleX);
          ctx.fill();
          
          ctx.fillStyle = 'white';
          ctx.font = '24px Inter, sans-serif';
          ctx.fillText(nameTag.innerText, tx + 10 * scaleX, ty + 24 * scaleY);
        }
      }
    });

    // 3. Draw Logo Override
    if (logoImageRef.current) {
      const logoW = 150;
      const ratio = logoImageRef.current.height / logoImageRef.current.width;
      const logoH = logoW * ratio;
      ctx.drawImage(logoImageRef.current, 1920 - logoW - 40, 40, logoW, logoH);
    }

    // 4. Draw Active Banners
    const activeBanners = banners.filter(b => b.visible);
    if (activeBanners.length > 0) {
      const banner = activeBanners[0]; // Streaming engines typically composite one primary banner
      const bh = 100;
      const by = 1080 - bh - 80; // 80px margin from bottom
      const bw = 1760;
      const bx = 80;
      
      ctx.fillStyle = banner.theme === 'dark' ? '#1e293b' : brandColor;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 12);
      ctx.fill();
      
      ctx.fillStyle = 'white';
      ctx.font = 'bold 38px Inter, sans-serif';
      ctx.fillText(banner.text, bx + 40, by + 62);
    }
    
    // 5. Draw Active Tickers
    const activeTickers = tickers.filter(t => t.visible);
    if (activeTickers.length > 0) {
      const ticker = activeTickers[0];
      const th = 60;
      const ty = 1080 - th;
      
      ctx.fillStyle = brandColor;
      ctx.fillRect(0, ty, 1920, th);
      
      ctx.fillStyle = 'white';
      ctx.font = '28px Inter, sans-serif';
      // Simple static text since marquee animation speed is hard to sync efficiently in raw canvas without an offset counter
      ctx.fillText(ticker.text, 40, ty + 40);
    }

    // Loop
    rAF.current = requestAnimationFrame(drawLoop);
  }, [containerRef, banners, lowerThirds, tickers, brandColor]);

  useEffect(() => {
    if (isLive) {
      console.log('Compositor Engine Started: Drawing 1080p canvas at 30FPS');
      cancelAnimationFrame(rAF.current); // Guard against multi-ticks
      rAF.current = requestAnimationFrame(drawLoop);
    } else {
      cancelAnimationFrame(rAF.current);
    }
    
    // Cleanup to prevent memory leaks when drawLoop dependencies change
    return () => {
      cancelAnimationFrame(rAF.current);
    };
  }, [isLive, drawLoop]);

  return { compositeStreamRef, compositeCanvasRef: canvasRef };
}
