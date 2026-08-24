export const THEME_STORAGE_KEY = "sk-theme";

export type Theme = "light" | "dark";

export function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage may be unavailable (private browsing, disabled storage) — the
    // toggle still works for the current page load, it just won't persist.
  }
}

/** Inline, unminified source for the anti-flash boot script — read directly
 * into layout.tsx's inline <script>. Runs before paint so the stored theme
 * applies immediately instead of flashing light-then-dark on load. */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=window.localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="dark"){document.documentElement.setAttribute("data-theme","dark");}}catch(e){}})();`;
