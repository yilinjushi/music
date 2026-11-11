import { Palette, WifiOff } from "lucide-react";
import { ThemeToggle } from "../ThemeToggle";
import { Switch } from "../ui/switch";
import { AutoMatchSetting } from "./AutoMatchSetting";
import { IssueLogs } from "./IssueLogs";
import { NeteaseLogin } from "./NeteaseLogin";
import { QualitySelect } from "./QualitySelect";
import { SettingItem } from "./SettingItem";
import { setManualLocalOnly, useManualLocalOnly } from "@/lib/network-policy";

function SettingsCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-2xl bg-card px-4 [&>*:last-child]:border-b-0">
      {children}
    </div>
  );
}

export function DeferredSettingsContent() {
  const localOnly = useManualLocalOnly();

  return (
    <>
      <SettingsCard>
        <SettingItem
          icon={WifiOff}
          title="离线模式"
          subtitle="只播手机里已存的歌，不联网"
          action={
            <Switch
              aria-label="离线模式"
              checked={localOnly}
              onCheckedChange={setManualLocalOnly}
            />
          }
        />
        <QualitySelect />
        <AutoMatchSetting />
      </SettingsCard>

      <SettingsCard>
        <SettingItem icon={Palette} title="主题切换" action={<ThemeToggle />} />
        <NeteaseLogin />
      </SettingsCard>

      <SettingsCard>
        <IssueLogs />
      </SettingsCard>
    </>
  );
}
