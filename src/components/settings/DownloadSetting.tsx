import { useState } from "react";
import { Download } from "lucide-react";
import { useMusicStore } from "@/store/music-store";
import { useShallow } from "zustand/react/shallow";
import { SettingItem } from "./SettingItem";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const QUALITY_LABELS: Record<string, string> = {
  "128": "标准",
  "192": "高品",
  "320": "极高",
  "999": "无损",
};

function buildSummary(
  quality: string,
  embedCover: boolean,
  embedLyric: boolean
): string {
  const parts: string[] = [];
  parts.push(QUALITY_LABELS[quality] ?? "标准");
  if (embedCover && embedLyric) parts.push("封面&歌词");
  else if (embedCover) parts.push("封面");
  else if (embedLyric) parts.push("歌词");
  else parts.push("无嵌入");
  return parts.join(" · ");
}

export function DownloadSetting() {
  const {
    downloadQuality,
    setDownloadQuality,
    embedCover,
    setEmbedCover,
    embedLyric,
    setEmbedLyric,
  } = useMusicStore(
    useShallow((state) => ({
      downloadQuality: state.downloadQuality,
      setDownloadQuality: state.setDownloadQuality,
      embedCover: state.embedCover,
      setEmbedCover: state.setEmbedCover,
      embedLyric: state.embedLyric,
      setEmbedLyric: state.setEmbedLyric,
    }))
  );

  const [expanded, setExpanded] = useState(false);
  const summary = buildSummary(downloadQuality, embedCover, embedLyric);

  return (
    <SettingItem
      icon={Download}
      title="下载设置"
      subtitle={summary}
      onClick={() => setExpanded(!expanded)}
      showChevron
      isExpanded={expanded}
      expandedContent={
        <div className="space-y-3">
          <Row label="下载音质">
            <Select value={downloadQuality} onValueChange={setDownloadQuality}>
              <SelectTrigger
                aria-label="下载音质"
                className="h-7 px-2 bg-transparent border-muted hover:bg-muted/20 w-40"
              >
                <SelectValue placeholder="音质" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="128">标准 (128kbps)</SelectItem>
                <SelectItem value="192">高品 (192kbps)</SelectItem>
                <SelectItem value="320">极高 (320kbps)</SelectItem>
                <SelectItem value="999">无损 (999kbps)</SelectItem>
              </SelectContent>
            </Select>
          </Row>

          <Row label="内嵌封面">
            <Switch
              aria-label="内嵌封面"
              checked={embedCover}
              onCheckedChange={setEmbedCover}
            />
          </Row>

          <Row label="内嵌歌词">
            <Switch
              aria-label="内嵌歌词"
              checked={embedLyric}
              onCheckedChange={setEmbedLyric}
            />
          </Row>

          <p className="text-xs text-muted-foreground">
            文件将通过 Chrome 的下载管理器保存。
          </p>
        </div>
      }
    />
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex flex-col min-w-0">
        <span className="text-sm text-foreground">{label}</span>
        {hint && (
          <span className="text-xs text-muted-foreground truncate max-w-[200px]">
            {hint}
          </span>
        )}
      </div>
      <div onClick={(e) => e.stopPropagation()} className="shrink-0">
        {children}
      </div>
    </div>
  );
}
