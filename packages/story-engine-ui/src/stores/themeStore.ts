import { create } from "zustand";

export type ThemeMode = "dark" | "light";

const STORAGE_KEY = "story-engine-ng.theme";

function loadInitialMode(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return "dark";
}

function applyMode(mode: ThemeMode): void {
  document.documentElement.classList.toggle("theme-light", mode === "light");
  document.documentElement.classList.toggle("theme-dark", mode === "dark");
}

export interface ThemeStore {
  readonly mode: ThemeMode;
  readonly toggle: () => void;
  readonly setMode: (mode: ThemeMode) => void;
}

export const useThemeStore = create<ThemeStore>((set) => {
  const initialMode = loadInitialMode();
  applyMode(initialMode);

  return {
    mode: initialMode,
    toggle: () =>
      set((state) => {
        const next = state.mode === "dark" ? "light" : "dark";
        localStorage.setItem(STORAGE_KEY, next);
        applyMode(next);
        return { mode: next };
      }),
    setMode: (mode) =>
      set(() => {
        localStorage.setItem(STORAGE_KEY, mode);
        applyMode(mode);
        return { mode };
      }),
  };
});
