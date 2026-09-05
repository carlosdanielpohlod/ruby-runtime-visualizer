import { useEffect } from "react";

export interface Shortcuts {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  step: (direction: 1 | -1) => void;
  togglePlay: () => void;
  jumpStart: () => void;
  jumpEnd: () => void;
  escape: () => void;
}

const EDITABLE = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON"]);

export function useKeyboardShortcuts(shortcuts: Shortcuts | null): void {
  useEffect(() => {
    if (!shortcuts) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && EDITABLE.has(target.tagName)) return;
      const handled = (): void => event.preventDefault();
      switch (event.key) {
        case "+":
        case "=":
          shortcuts.zoomIn();
          return handled();
        case "-":
        case "_":
          shortcuts.zoomOut();
          return handled();
        case "0":
          shortcuts.fit();
          return handled();
        case "ArrowRight":
          shortcuts.step(1);
          return handled();
        case "ArrowLeft":
          shortcuts.step(-1);
          return handled();
        case " ":
          shortcuts.togglePlay();
          return handled();
        case "Home":
          shortcuts.jumpStart();
          return handled();
        case "End":
          shortcuts.jumpEnd();
          return handled();
        case "Escape":
          shortcuts.escape();
          return handled();
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcuts]);
}
