"use client";

import { lazy, startTransition, Suspense, useEffect, useState } from "react";
import { PageLayout } from "./PageLayout";
import { AggregatedSourceSelect } from "./settings/AggregatedSourceSelect";

const DeferredSettingsContent = lazy(() =>
  import("./settings/SettingsDeferredContent").then((module) => ({
    default: module.DeferredSettingsContent,
  }))
);

interface SettingsPageProps {
  onBack?: () => void;
}

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

export function SettingsPage({ onBack }: SettingsPageProps) {
  const [renderDeferredSettings, setRenderDeferredSettings] = useState(false);

  useEffect(() => {
    // `useEffect` may still run before the browser has painted the first
    // settings frame. Starting the large below-the-fold import immediately
    // made that optional work compete with the route's first contentful paint.
    // Two animation frames guarantee one paint opportunity before the import
    // is requested, while keeping the remaining settings automatic.
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        startTransition(() => setRenderDeferredSettings(true));
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, []);

  return (
    <PageLayout title="系统设置" onBack={onBack}>
      <div className="flex-1 p-4 pb-bottom-stack overflow-y-auto">
        <SettingsSection title="常用设置">
          <AggregatedSourceSelect />
          <p className="pt-3 text-xs leading-relaxed text-muted-foreground">
            聚合搜索会同时查询已启用的音源。点击上方“聚合音源”可以选择要用的音源，并拖动调整先后顺序。
          </p>
        </SettingsSection>

        {renderDeferredSettings && (
          <Suspense fallback={null}>
            <DeferredSettingsContent />
          </Suspense>
        )}
      </div>
    </PageLayout>
  );
}
