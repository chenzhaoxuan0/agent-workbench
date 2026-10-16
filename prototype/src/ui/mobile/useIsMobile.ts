import { useEffect } from "react";
import { create } from "zustand";

export type LayoutPreference = "auto" | "mobile" | "desktop";

interface LayoutStore {
  preference: LayoutPreference;
  windowIsMobile: boolean;
  setPreference: (p: LayoutPreference) => void;
  setWindowIsMobile: (w: boolean) => void;
}

const getInitialPreference = (): LayoutPreference => {
  if (typeof window === "undefined") return "auto";
  try {
    const stored = localStorage.getItem("agent-workbench:layout-pref");
    if (stored === "mobile" || stored === "desktop") return stored;
  } catch {}
  return "auto";
};

const checkWindowIsMobile = (): boolean => {
  if (typeof window === "undefined") return false;
  // 仅在真实手机窄屏宽度（< 640px，Tailwind sm 断点）下使用单列手机布局；平板端（640px~1024px）保持完整横向空间
  return window.innerWidth < 640;
};

export const useLayoutStore = create<LayoutStore>((set) => ({
  preference: getInitialPreference(),
  windowIsMobile: checkWindowIsMobile(),
  setPreference: (p) => {
    set({ preference: p });
    try {
      localStorage.setItem("agent-workbench:layout-pref", p);
    } catch {}
  },
  setWindowIsMobile: (w) => set({ windowIsMobile: w }),
}));

export function useIsMobile(): {
  isMobile: boolean;
  preference: LayoutPreference;
  setPreference: (p: LayoutPreference) => void;
  windowIsMobile: boolean;
} {
  const preference = useLayoutStore((s) => s.preference);
  const windowIsMobile = useLayoutStore((s) => s.windowIsMobile);
  const setPreference = useLayoutStore((s) => s.setPreference);
  const setWindowIsMobile = useLayoutStore((s) => s.setWindowIsMobile);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const check = () => {
      setWindowIsMobile(checkWindowIsMobile());
    };

    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
    };
  }, [setWindowIsMobile]);

  const isMobile =
    preference === "mobile"
      ? true
      : preference === "desktop"
        ? false
        : windowIsMobile;

  return { isMobile, preference, setPreference, windowIsMobile };
}

