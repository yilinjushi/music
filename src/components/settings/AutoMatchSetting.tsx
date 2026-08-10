import { useState } from "react";
import { ChevronRight, Wand2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useMusicStore } from "@/store/music-store";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox"; // 引入 Checkbox
import { SettingItem } from "./SettingItem";
import { Button } from "@/components/ui/button";

export function AutoMatchSetting() {
  const {
    enableAutoMatch,
    setEnableAutoMatch,
    autoMatchFavorites,
    setAutoMatchFavorites,
    autoMatchPlaylists,
    setAutoMatchPlaylists,
  } = useMusicStore(
    useShallow((s) => ({
      enableAutoMatch: s.enableAutoMatch,
      setEnableAutoMatch: s.setEnableAutoMatch,
      autoMatchFavorites: s.autoMatchFavorites,
      setAutoMatchFavorites: s.setAutoMatchFavorites,
      autoMatchPlaylists: s.autoMatchPlaylists,
      setAutoMatchPlaylists: s.setAutoMatchPlaylists,
    }))
  );

  const [expanded, setExpanded] = useState(false);

  const summary = !enableAutoMatch
    ? "已关闭"
    : [
        "已开启",
        autoMatchFavorites && "喜欢同步",
        autoMatchPlaylists && "歌单同步",
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <SettingItem
      icon={Wand2}
      title="智能音源"
      subtitle={summary}
      action={
        <div className="flex items-center gap-1">
          <Switch
            aria-label="智能音源"
            checked={enableAutoMatch}
            onCheckedChange={setEnableAutoMatch}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={expanded ? "收起智能音源设置" : "展开智能音源设置"}
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
          >
            <ChevronRight
              aria-hidden="true"
              className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </Button>
        </div>
      }
      isExpanded={expanded}
      expandedContent={
        /* 改造为两列网格布局，在小屏下可自动降级为一列防止挤压 */
        <div
          className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 子项 1 */}
          <label
            className={`flex items-start gap-3 text-sm cursor-pointer select-none ${!enableAutoMatch ? "opacity-50 pointer-events-none" : ""}`}
          >
            <Checkbox
              className="mt-0.5 shrink-0"
              checked={autoMatchFavorites}
              onCheckedChange={(checked) => setAutoMatchFavorites(!!checked)}
              disabled={!enableAutoMatch}
            />
            <span className="text-muted-foreground leading-snug">
              同步更新当前「我的喜欢」中的歌曲
            </span>
          </label>

          {/* 子项 2 */}
          <label
            className={`flex items-start gap-3 text-sm cursor-pointer select-none ${!enableAutoMatch ? "opacity-50 pointer-events-none" : ""}`}
          >
            <Checkbox
              className="mt-0.5 shrink-0"
              checked={autoMatchPlaylists}
              onCheckedChange={(checked) => setAutoMatchPlaylists(!!checked)}
              disabled={!enableAutoMatch}
            />
            <span className="text-muted-foreground leading-snug">
              同步更新当前「本地歌单」中的歌曲
            </span>
          </label>
        </div>
      }
    />
  );
}
