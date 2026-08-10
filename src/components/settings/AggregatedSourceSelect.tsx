import { useMusicStore } from "@/store/music-store";
import { useShallow } from "zustand/react/shallow";
import { aggregatedSourceOptions } from "@/types/music";
import { lazy, Suspense, useState } from "react";
import { Loader2, Radio } from "lucide-react";
import { SettingItem } from "./SettingItem";

const AggregatedSourceEditor = lazy(() =>
  import("./AggregatedSourceEditor").then((module) => ({
    default: module.AggregatedSourceEditor,
  }))
);

export function AggregatedSourceSelect() {
  const sourceConfigs = useMusicStore(
    useShallow((state) => ({
      sourceConfigs: state.sourceConfigs,
    }))
  ).sourceConfigs;
  const [showSourcePicker, setShowSourcePicker] = useState(false);

  const selectedLabels = sourceConfigs
    .filter((c) => c.enabled)
    .map(
      (c) => aggregatedSourceOptions.find((o) => o.value === c.source)?.label
    )
    .filter(Boolean)
    .join("\u3001");

  return (
    <SettingItem
      icon={Radio}
      title="聚合音源"
      action={
        <span className="text-sm truncate max-w-[140px]">{selectedLabels}</span>
      }
      onClick={() => setShowSourcePicker(!showSourcePicker)}
      showChevron
      isExpanded={showSourcePicker}
      expandedContent={
        showSourcePicker ? (
          <Suspense
            fallback={
              <div
                className="flex min-h-20 items-center justify-center"
                role="status"
                aria-label="正在加载音源设置"
              >
                <Loader2
                  aria-hidden="true"
                  className="h-5 w-5 animate-spin text-primary"
                />
              </div>
            }
          >
            <AggregatedSourceEditor />
          </Suspense>
        ) : null
      }
    />
  );
}
