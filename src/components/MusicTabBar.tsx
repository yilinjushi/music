"use client";

import { Search, Heart, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { Link, useLocation } from "react-router-dom";

export type TabId = "home" | "search" | "mine";

interface TabItem {
  id: TabId;
  label: string;
  icon: typeof Search;
  path: string;
}

const tabs: TabItem[] = [
  { id: "home", label: "红心", icon: Heart, path: "/" },
  { id: "search", label: "搜索", icon: Search, path: "/search" },
  { id: "mine", label: "我的", icon: User, path: "/mine" },
];

export function MusicTabBar() {
  const location = useLocation();

  // Determine active tab based on current path
  const getActiveTab = (pathname: string): TabId => {
    if (pathname.startsWith("/search")) return "search";
    if (pathname.startsWith("/mine")) return "mine";
    return "home";
  };

  const activeTab = getActiveTab(location.pathname);

  return (
    <nav className="flex h-(--tab-bar-safe-height) items-start justify-around bg-background border-t-2 border-foreground px-2 pt-2 pb-[calc(0.5rem+var(--safe-area-bottom))]">
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        const Icon = tab.icon;
        return (
          <Link
            key={tab.id}
            to={tab.path}
            className={cn(
              "flex min-h-11 min-w-[56px] flex-col items-center justify-center gap-0.5 border-t-2 px-3 py-1 transition-colors",
              isActive
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground"
            )}
            aria-label={tab.label}
          >
            <Icon
              className={cn("h-5 w-5 transition-all")}
              strokeWidth={isActive ? 2.5 : 2}
            />
            <span className="text-xs font-bold tracking-widest">
              {tab.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
