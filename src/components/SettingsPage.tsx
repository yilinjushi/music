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
    <PageLayout title="设置" onBack={onBack}>
      <div className="flex-1 p-4 pb-bottom-stack overflow-y-auto">
        <div className="mb-4 rounded-2xl bg-card px-4 [&>*:last-child]:border-b-0">
          <AggregatedSourceSelect />
        </div>

        {renderDeferredSettings && (
          <Suspense fallback={null}>
            <DeferredSettingsContent />
          </Suspense>
        )}
      </div>
    </PageLayout>
  );
}
