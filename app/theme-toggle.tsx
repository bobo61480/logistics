"use client";

import { useEffect, useState } from "react";
import { applyTheme, getStoredTheme, type Theme } from "./theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTheme(getStoredTheme());
    setMounted(true);
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  };

  // Avoid rendering a theme-dependent label until after hydration reads the
  // real stored value — prevents a light/dark mismatch flash on the button.
  if (!mounted) {
    return (
      <button type="button" className="theme-toggle" aria-label="Toggle dark mode" disabled>
        Theme
      </button>
    );
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-pressed={theme === "dark"}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark" ? "Dark" : "Light"}
    </button>
  );
}
