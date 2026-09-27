import { lazy, Suspense, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import {
  Database,
  Image,
  Palette,
  Shield,
  Tag,
  Trash2,
  Volume2,
  Wand2,
} from "lucide-react";
import {
  useMusicStore,
  type FullScreenBackgroundMode,
} from "@/store/music-store";
import { ThemeToggle } from "../ThemeToggle";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Slider } from "../ui/slider";
import { Switch } from "../ui/switch";
import { ApiUrlConfig } from "./ApiUrlConfig";
import { AutoMatchSetting } from "./AutoMatchSetting";
import { AutoMatchSuffixSetting } from "./AutoMatchSuffixSetting";
import { DownloadSetting } from "./DownloadSetting";
import { IssueLogs } from "./IssueLogs";
import { NeteaseLogin } from "./NeteaseLogin";
import { PlaybackSpeedSetting } from "./PlaybackSpeedSetting";
import { QualitySelect } from "./QualitySelect";
import { SettingItem } from "./SettingItem";
import { SleepTimerSetting } from "./SleepTimerSetting";

const DataBackup = lazy(() =>
  import("./DataBackup").then((module) => ({
    default: module.DataBackup,
  }))
);

function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <h2 className="border-b-2 border-foreground pb-1 text-xs font-extrabold tracking-[0.2em] text-primary">
        {title}
      </h2>
      <div>{children}</div>
    </div>
  );
}

export function DeferredSettingsContent() {
  const navigate = useNavigate();
  const [dataBackupOpen, setDataBackupOpen] = useState(false);
  const {
    volume,
    setVolume,
    enableAutoMatch,
    enableProxyFallback,
    setEnableProxyFallback,
    bilibiliKeepOriginalMeta,
    setBilibiliKeepOriginalMeta,
    showSourceBadge,
    setShowSourceBadge,
    fullScreenBackgroundMode,
    setFullScreenBackgroundMode,
  } = useMusicStore(
    useShallow((state) => ({
      volume: state.volume,
      setVolume: state.setVolume,
      enableAutoMatch: state.enableAutoMatch,
      enableProxyFallback: state.enableProxyFallback,
      setEnableProxyFallback: state.setEnableProxyFallback,
      bilibiliKeepOriginalMeta: state.bilibiliKeepOriginalMeta,
      setBilibiliKeepOriginalMeta: state.setBilibiliKeepOriginalMeta,
      showSourceBadge: state.showSourceBadge,
      setShowSourceBadge: state.setShowSourceBadge,
      fullScreenBackgroundMode: state.fullScreenBackgroundMode,
      setFullScreenBackgroundMode: state.setFullScreenBackgroundMode,
    }))
  );

  return (
    <>
      <SettingsSection title="播放与下载">
        <SettingItem
          icon={Volume2}
          title="音量调节"
          action={
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground w-10 text-right">
                {Math.round(volume * 100)}%
              </span>
              <Slider
                aria-label="音量调节"
                value={[volume * 100]}
                onValueChange={([value]) => setVolume(value / 100)}
                min={0}
                max={100}
                step={1}
                className="w-32"
              />
            </div>
          }
        />
        <QualitySelect />
        <SleepTimerSetting />
        <PlaybackSpeedSetting />
        <DownloadSetting />
      </SettingsSection>

      <SettingsSection title="界面设置">
        <SettingItem icon={Palette} title="主题切换" action={<ThemeToggle />} />
        <SettingItem
          icon={Tag}
          title="显示音源标签"
          subtitle="在歌曲列表中始终显示音源平台标签"
          action={
            <Switch
              aria-label="显示音源标签"
              checked={showSourceBadge}
              onCheckedChange={setShowSourceBadge}
            />
          }
        />
        <SettingItem
          icon={Image}
          title="全屏背景"
          action={
            <Select
              value={fullScreenBackgroundMode}
              onValueChange={(value) =>
                setFullScreenBackgroundMode(value as FullScreenBackgroundMode)
              }
            >
              <SelectTrigger
                aria-label="全屏背景"
                className="h-7 px-2 bg-transparent border-muted hover:bg-muted/20 w-36"
              >
                <SelectValue placeholder="背景" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="theme">动态主题色</SelectItem>
                <SelectItem value="cover">模糊封面</SelectItem>
                <SelectItem value="texture">深色质感</SelectItem>
              </SelectContent>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="账号数据">
        <NeteaseLogin />
        <SettingItem
          icon={Database}
          title="数据备份"
          subtitle="导出或导入全部收藏、歌单与设置"
          onClick={() => setDataBackupOpen(true)}
          showChevron
        />
        <SettingItem
          icon={Trash2}
          title="回收站"
          subtitle="恢复误删的歌曲和歌单"
          onClick={() => navigate("/settings/trash")}
          showChevron
        />
      </SettingsSection>

      <SettingsSection title="B站设置">
        <SettingItem
          icon={Wand2}
          title="换源保留原信息"
          subtitle="自动换源到B站时保留原标题和歌手"
          action={
            <Switch
              aria-label="换源保留原信息"
              checked={bilibiliKeepOriginalMeta}
              onCheckedChange={setBilibiliKeepOriginalMeta}
              disabled={!enableAutoMatch}
            />
          }
        />
        <AutoMatchSuffixSetting />
      </SettingsSection>

      <SettingsSection title="高级设置">
        <ApiUrlConfig />
        <SettingItem
          icon={Shield}
          title="代理回退"
          subtitle="自动切换代理线路（但容易卡顿）"
          action={
            <Switch
              aria-label="代理回退"
              checked={enableProxyFallback}
              onCheckedChange={setEnableProxyFallback}
            />
          }
        />
        <AutoMatchSetting />
      </SettingsSection>

      <SettingsSection title="关于系统">
        <IssueLogs />
      </SettingsSection>

      {dataBackupOpen && (
        <Suspense fallback={null}>
          <DataBackup open onOpenChange={setDataBackupOpen} />
        </Suspense>
      )}
    </>
  );
}
