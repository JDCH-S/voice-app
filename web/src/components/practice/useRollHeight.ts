import { useEffect, useState } from 'react';

/** Below this width the practice view stacks into one column (phones and small tablets). */
export const PHONE_MAX_WIDTH = 900;

function compute(): { height: number; phone: boolean } {
  if (typeof window === 'undefined') return { height: 430, phone: false };
  const w = window.innerWidth;
  const h = window.innerHeight;
  const phone = w < PHONE_MAX_WIDTH;
  if (!phone) return { height: h < 760 ? Math.max(300, Math.round(h * 0.5)) : 430, phone };
  // phone: the roll takes a good share of the screen but leaves room for the transport below it
  const landscape = w > h;
  const height = landscape ? Math.max(180, Math.round(h * 0.6)) : Math.min(380, Math.max(220, Math.round(h * 0.36)));
  return { height, phone };
}

/** Piano-roll height derived from the viewport, and whether we are on a phone-sized screen. */
export function useRollHeight(): { height: number; phone: boolean } {
  const [v, setV] = useState(compute);
  useEffect(() => {
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setV(compute()));
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);
  return v;
}
