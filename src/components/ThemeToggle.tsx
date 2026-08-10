"use client";

import { Moon, Sun, SunMoon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useThemePreference } from "@/components/ui/theme-provider";

export function ThemeToggle() {
  const { themePref, setThemePref } = useThemePreference();
  const ThemeIcon =
    themePref === "system" ? SunMoon : themePref === "dark" ? Moon : Sun;

  const handleToggleTheme = () => {
    setThemePref(
      themePref === "system"
        ? "light"
        : themePref === "light"
          ? "dark"
          : "system"
    );
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleToggleTheme}
      className="text-foreground/60 hover:bg-secondary/50 hover:text-foreground"
      title="主题切换"
      aria-label="主题切换"
    >
      <ThemeIcon className="h-4 w-4" />
    </Button>
  );
}
