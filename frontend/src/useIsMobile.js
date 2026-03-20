import { useState, useEffect } from "react";

/**
 * Returns true when the viewport is narrower than `breakpoint` pixels.
 * Re-evaluates on every resize event so components re-render automatically.
 */
export function useIsMobile(breakpoint = 720) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false
  );

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [breakpoint]);

  return isMobile;
}
