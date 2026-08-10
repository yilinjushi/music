import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { Eye, EyeOff, GripVertical } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useMusicStore } from "@/store/music-store";
import { aggregatedSourceOptions, type SourceConfig } from "@/types/music";

interface SourceItemProps {
  config: SourceConfig;
  onToggleEnabled: () => void;
  onToggleVisible: () => void;
  dragHandleProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  dragHandleRef?: (element: HTMLButtonElement | null) => void;
}

function SourceItem({
  config,
  onToggleEnabled,
  onToggleVisible,
  dragHandleProps,
  dragHandleRef,
}: SourceItemProps) {
  const option = aggregatedSourceOptions.find(
    (item) => item.value === config.source
  );
  if (!option) return null;

  return (
    <div className="flex items-center gap-4 py-2">
      {dragHandleProps ? (
        <button
          type="button"
          {...dragHandleProps}
          ref={dragHandleRef}
          aria-label={`拖动${option.label}音源排序`}
          className="flex size-11 shrink-0 touch-none select-none items-center justify-center text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing"
        >
          <GripVertical aria-hidden="true" className="h-4 w-4" />
        </button>
      ) : (
        <div
          aria-hidden="true"
          className="flex size-11 shrink-0 items-center justify-center text-muted-foreground"
        >
          <GripVertical className="h-4 w-4" />
        </div>
      )}

      <div className="flex flex-1 min-w-0 flex-col">
        <span className="text-sm text-foreground">{option.label}</span>
        <span className="text-xs text-muted-foreground">
          {option.description}
        </span>
      </div>

      <button
        type="button"
        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
        onClick={(event) => {
          event.stopPropagation();
          onToggleVisible();
        }}
        aria-label={
          config.visible ? `隐藏${option.label}` : `显示${option.label}`
        }
      >
        {config.visible ? (
          <Eye className="h-4 w-4" />
        ) : (
          <EyeOff className="h-4 w-4" />
        )}
      </button>

      <Checkbox
        aria-label={
          config.enabled ? `停用${option.label}` : `启用${option.label}`
        }
        checked={config.enabled}
        onCheckedChange={onToggleEnabled}
      />
    </div>
  );
}

function SortableSourceItem({
  config,
  onToggleEnabled,
  onToggleVisible,
}: {
  config: SourceConfig;
  onToggleEnabled: () => void;
  onToggleVisible: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    setActivatorNodeRef,
  } = useSortable({ id: config.source });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <SourceItem
        config={config}
        onToggleEnabled={onToggleEnabled}
        onToggleVisible={onToggleVisible}
        dragHandleProps={{ ...attributes, ...listeners }}
        dragHandleRef={setActivatorNodeRef}
      />
    </div>
  );
}

export function AggregatedSourceEditor() {
  const sourceConfigs = useMusicStore((state) => state.sourceConfigs);
  const setSourceConfigs = useMusicStore((state) => state.setSourceConfigs);
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const toggleEnabled = (source: string) => {
    const enabledCount = sourceConfigs.filter(
      (config) => config.enabled
    ).length;
    const target = sourceConfigs.find((config) => config.source === source);
    if (!target || (target.enabled && enabledCount <= 1)) return;

    setSourceConfigs(
      sourceConfigs.map((config) =>
        config.source === source
          ? { ...config, enabled: !config.enabled }
          : config
      )
    );
  };

  const toggleVisible = (source: string) => {
    setSourceConfigs(
      sourceConfigs.map((config) =>
        config.source === source
          ? { ...config, visible: !config.visible }
          : config
      )
    );
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = sourceConfigs.findIndex(
      (config) => config.source === active.id
    );
    const newIndex = sourceConfigs.findIndex(
      (config) => config.source === over.id
    );
    if (oldIndex === -1 || newIndex === -1) return;

    setSourceConfigs(arrayMove(sourceConfigs, oldIndex, newIndex));
  };

  const activeConfig = activeId
    ? sourceConfigs.find((config) => config.source === activeId)
    : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(event: DragStartEvent) =>
        setActiveId(event.active.id as string)
      }
      onDragEnd={handleDragEnd}
      modifiers={[restrictToVerticalAxis]}
    >
      <SortableContext
        items={sourceConfigs.map((config) => config.source)}
        strategy={verticalListSortingStrategy}
      >
        {sourceConfigs.map((config) => (
          <SortableSourceItem
            key={config.source}
            config={config}
            onToggleEnabled={() => toggleEnabled(config.source)}
            onToggleVisible={() => toggleVisible(config.source)}
          />
        ))}
      </SortableContext>
      <DragOverlay>
        {activeConfig ? (
          <div className="shadow-xl rounded-lg bg-card border">
            <SourceItem
              config={activeConfig}
              onToggleEnabled={() => {}}
              onToggleVisible={() => {}}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
