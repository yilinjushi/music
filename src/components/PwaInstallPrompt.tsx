import { useCallback, useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

function isStandaloneMode(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches ?? false;
}

export function PwaInstallPrompt() {
  const [installEvent, setInstallEvent] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(isStandaloneMode);
  const [isDismissed, setIsDismissed] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);

  useEffect(() => {
    const displayMode = window.matchMedia("(display-mode: standalone)");
    const syncDisplayMode = () => setIsInstalled(displayMode.matches);
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
      setIsDismissed(false);
    };
    const handleInstalled = () => {
      setInstallEvent(null);
      setIsInstalled(true);
      toast.success("网页播放器已安装");
    };

    syncDisplayMode();
    displayMode.addEventListener?.("change", syncDisplayMode);
    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);

    return () => {
      displayMode.removeEventListener?.("change", syncDisplayMode);
      window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!installEvent || isInstalling) return;
    setIsInstalling(true);
    try {
      await installEvent.prompt();
      const choice = await installEvent.userChoice;
      setInstallEvent(null);
      if (choice.outcome === "accepted") {
        toast.success("正在添加到主屏幕");
      } else {
        setIsDismissed(true);
      }
    } catch {
      setInstallEvent(null);
      toast.error("暂时无法安装，请从 Chrome 菜单选择“添加到主屏幕”");
    } finally {
      setIsInstalling(false);
    }
  }, [installEvent, isInstalling]);

  if (isInstalled || !installEvent || isDismissed) return null;

  return (
    <section
      aria-label="安装网页播放器"
      aria-live="polite"
      className="fixed inset-x-3 top-[calc(var(--safe-area-top)+12px)] z-[90] mx-auto max-w-md rounded-2xl border bg-background p-3 shadow-xl backdrop-blur"
    >
      <div className="flex items-center gap-3">
        <Download
          aria-hidden="true"
          className="h-5 w-5 shrink-0 text-primary"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">安装网页播放器</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Android Chrome 可直接安装；也可从浏览器菜单选择“添加到主屏幕”。
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={isInstalling}
          onClick={() => void install()}
        >
          {isInstalling ? "安装中" : "安装"}
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="稍后安装"
          onClick={() => setIsDismissed(true)}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}
