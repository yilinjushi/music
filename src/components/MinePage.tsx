"use client";

import { ListVideo, Settings } from "lucide-react";
import { MineSection } from "./PlaylistMarket/MineSection";
import { useNavigate } from "react-router-dom";

export function MinePage() {
  const navigate = useNavigate();

  const quickNavs = [
    { label: "列表", icon: ListVideo, path: "/queue" },
    { label: "设置", icon: Settings, path: "/settings" },
  ];

  return (
    <div className="p-5 pb-bottom-stack">
      <div className="mb-8 grid grid-cols-2 gap-3">
        {quickNavs.map(({ label, icon: Icon, path }) => (
          <button
            type="button"
            key={path}
            onClick={() => navigate(path)}
            className="flex flex-col items-center gap-2 rounded-2xl bg-card py-4 transition-colors hover:bg-muted"
          >
            <Icon className="h-6 w-6 text-primary" />
            <span className="text-xs text-muted-foreground">{label}</span>
          </button>
        ))}
      </div>

      <section aria-labelledby="netease-mine-title">
        <h2 id="netease-mine-title" className="mb-3 text-xl text-foreground">
          网易云
        </h2>
        <MineSection embedded />
      </section>
    </div>
  );
}
