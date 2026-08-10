"use client";

/* eslint-disable react-refresh/only-export-components */

import { createContext, useCallback, useContext, useState } from "react";
import {
  ThemeProvider as NextThemesProvider,
  type ThemeProviderProps,
} from "next-themes";

type ThemePreference = "system" | "light" | "dark";

interface ThemePreferenceContextValue {
  themePref: ThemePreference;
  setThemePref: (preference: ThemePreference) => void;
}

const ThemePreferenceContext = createContext<ThemePreferenceContextValue>({
  themePref: "system",
  setThemePref: () => undefined,
});

export function useThemePreference() {
  return useContext(ThemePreferenceContext);
}

function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem("theme");
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    return "system";
  }
  return "system";
}

export function AppThemeProvider({ children, ...props }: ThemeProviderProps) {
  const [themePref, setThemePrefState] =
    useState<ThemePreference>(readStoredPreference);

  const setThemePref = useCallback((preference: ThemePreference) => {
    setThemePrefState(preference);
    try {
      localStorage.setItem("theme", preference);
    } catch {
      return;
    }
  }, []);

  const forcedTheme = themePref === "system" ? undefined : themePref;

  return (
    <ThemePreferenceContext.Provider value={{ themePref, setThemePref }}>
      <NextThemesProvider {...props} forcedTheme={forcedTheme}>
        {children}
      </NextThemesProvider>
    </ThemePreferenceContext.Provider>
  );
}
