import { useEffect, useRef, useCallback, useState } from 'react';

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos
const WARNING_MS = 30 * 1000; // 30 segundos de advertencia
const THROTTLE_MS = 1000; // 1 segundo entre resets (protege contra scroll-spam)

export function useInactivityTimer(onTimeout: () => void) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warningRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastResetRef = useRef<number>(0);
  const [showWarning, setShowWarning] = useState(false);

  const resetTimer = useCallback(() => {
    // Throttle: ignorar si pasó menos de THROTTLE_MS desde el último reset
    const now = Date.now();
    if (now - lastResetRef.current < THROTTLE_MS) return;
    lastResetRef.current = now;

    // Limpiar BOS timeouts anteriores (el bug: solo se limpiaba timerRef, no warningRef)
    if (timerRef.current) clearTimeout(timerRef.current);
    if (warningRef.current) clearTimeout(warningRef.current);
    setShowWarning(false);

    // Mostrar advertencia 30s antes del timeout
    warningRef.current = setTimeout(() => setShowWarning(true), TIMEOUT_MS - WARNING_MS);
    // Timeout real
    timerRef.current = setTimeout(() => {
      setShowWarning(false);
      onTimeout();
    }, TIMEOUT_MS);
  }, [onTimeout]);

  useEffect(() => {
    const events = ['mousedown', 'touchstart', 'keydown', 'scroll', 'click'] as const;

    const handler = () => resetTimer();

    resetTimer();
    events.forEach((e) => window.addEventListener(e, handler));

    return () => {
      events.forEach((e) => window.removeEventListener(e, handler));
      if (timerRef.current) clearTimeout(timerRef.current);
      if (warningRef.current) clearTimeout(warningRef.current);
    };
  }, [resetTimer]);

  const dismissWarning = useCallback(() => {
    setShowWarning(false);
    resetTimer();
  }, [resetTimer]);

  return { showWarning, dismissWarning };
}