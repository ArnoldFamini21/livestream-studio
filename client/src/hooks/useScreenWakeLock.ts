import { useEffect, useRef, useState } from 'react';
import { createScreenWakeLockController, type ScreenWakeLockController, type ScreenWakeLockStatus } from '../utils/screenWakeLock.ts';

/** Hold a Screen Wake Lock while `active` (recording, live or on stage). */
export function useScreenWakeLock(active: boolean): ScreenWakeLockStatus {
  const [status, setStatus] = useState<ScreenWakeLockStatus>('idle');
  const controllerRef = useRef<ScreenWakeLockController | null>(null);

  useEffect(() => {
    const controller = createScreenWakeLockController({ onStatus: setStatus });
    controllerRef.current = controller;
    setStatus(controller.status());
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setActive(active);
  }, [active]);

  return status;
}
