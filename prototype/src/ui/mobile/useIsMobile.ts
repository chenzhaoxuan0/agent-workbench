import { useEffect, useState } from "react";

export type LayoutPreference = "auto" | "mobile" | "desktop";

export function useIsMobile(): {
  isMobile: boolean;
  preference: LayoutPreference;
  setPreference: (p: LayoutPreference) => void;
} {
  const [preference, setPreferenceState] = useState<LayoutPreference>(() => {
    try {
      const stored = localStorage.getItem("agent-workbench:layout-pref");
      if (stored === "mobile" || stored === "desktop") return stored;
    } catch {}
    return "auto";
  });

  const [windowIsMobile, setWindowIsMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    // 判定触控屏或窄屏手机
    const isNarrow = window.innerWidth < 768;
    const isTouch = navigator.maxTouchPoints > 0 && window.innerWidth < 1024;
    return isNarrow || isTouch;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const check = () => {
      const isNarrow = window.innerWidth < 768;
      const isTouch = navigator.maxTouchPoints > 0 && window.innerWidth < 1024;
      setWindowIsMobile(isNarrow || isTouch);
    };

    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
    };
  }, []);

  const setPreference = (p: LayoutPreference) => {
    setPreferenceState(p);
    try {
      localStorage.setItem("agent-workbench:layout-pref", p);
    } catch {}
  };

  const isMobile =
    preference === "mobile"
      ? true
      : preference === "desktop"
        ? false
        : windowIsMobile;

  return { isMobile, preference, setPreference };
}
