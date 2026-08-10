"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Music2, Download, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { forceHttps } from "@shared/utils/url";
import { useExitLayer } from "@/hooks/useExitLayer";
import toast from "react-hot-toast";

interface MusicCoverProps {
  src?: string | null;
  alt?: string;
  className?: string;
  iconClassName?: string;
  fallbackIcon?: React.ReactNode;
  previewable?: boolean;
}

export function MusicCover({
  src,
  alt = "Cover",
  className,
  iconClassName,
  fallbackIcon,
  previewable = false,
}: MusicCoverProps) {
  const [error, setError] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const { push, pop } = useExitLayer();
  const coverUrl = forceHttps(src);

  // src 变化时重置错误状态，让新的封面 URL 有机会重新加载
  useEffect(() => {
    setError(false);
  }, [src]);

  useEffect(() => {
    if (!isPreviewOpen) return;
    const id = push({ close: () => setIsPreviewOpen(false) });
    return () => {
      pop(id);
    };
  }, [isPreviewOpen, push, pop]);

  const handleSave = async () => {
    if (!coverUrl || isSaving) return;
    setIsSaving(true);

    try {
      const filename = `${alt.replace(/[\\/:*?"<>|]/g, "_")}.jpg`;

      const response = await fetch(coverUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const { triggerBlobDownload } = await import("@/lib/utils/download");
      triggerBlobDownload(blob, filename);
    } catch {
      toast.error("保存失败，请重试");
    } finally {
      setIsSaving(false);
    }
  };

  if (!src || error) {
    return (
      <div
        className={cn(
          "w-full h-full bg-muted flex items-center justify-center shrink-0",
          className
        )}
      >
        {fallbackIcon || (
          <Music2 className={cn("text-muted-foreground/50", iconClassName)} />
        )}
      </div>
    );
  }

  return (
    <>
      <img
        src={coverUrl}
        alt={alt}
        className={cn(
          "w-full h-full object-cover shrink-0",
          previewable && "cursor-pointer",
          className
        )}
        draggable={false}
        onError={() => setError(true)}
        onClick={() => previewable && setIsPreviewOpen(true)}
        onKeyDown={(event) => {
          if (previewable && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            setIsPreviewOpen(true);
          }
        }}
        role={previewable ? "button" : undefined}
        tabIndex={previewable ? 0 : undefined}
        aria-label={previewable ? `预览封面：${alt}` : undefined}
        onContextMenu={(e) => e.preventDefault()}
      />

      {previewable &&
        isPreviewOpen &&
        createPortal(
          <div
            data-testid="cover-preview-portal"
            className="fixed inset-0 z-500 flex flex-col items-center justify-center bg-black select-none animate-in fade-in duration-200"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                setIsPreviewOpen(false);
              }
            }}
            role="dialog"
            aria-modal="true"
            aria-label={`封面预览：${alt}`}
          >
            <img
              src={coverUrl}
              alt={alt}
              className="max-w-full max-h-[80vh] object-contain pointer-events-none"
            />

            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void handleSave();
              }}
              disabled={isSaving}
              className="touch-target absolute bottom-5 flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-full text-sm transition-colors border border-white/10 disabled:opacity-50"
            >
              <Download size={16} />
              {isSaving ? "保存中..." : "保存图片"}
            </button>
            <button
              type="button"
              className="touch-target absolute right-4 top-[calc(var(--safe-area-top)+1rem)] flex items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
              onClick={() => setIsPreviewOpen(false)}
              aria-label="关闭封面预览"
            >
              <X aria-hidden="true" className="h-5 w-5" />
            </button>
          </div>,
          document.body
        )}
    </>
  );
}
