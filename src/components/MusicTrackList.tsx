import React, {
  ReactNode,
  RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragOverlay,
  defaultDropAnimationSideEffects,
  DropAnimation,
  DragStartEvent,
} from "@dnd-kit/core";
import {
  restrictToVerticalAxis,
  restrictToWindowEdges,
} from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import {
  ListChecks,
  Plus,
  Heart,
  Download,
  Trash2,
  Loader2,
  Search,
  Check,
  MoreVertical,
  ListPlus,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { MusicTrackItem } from "./MusicTrackItem";
import { AddToPlaylistDrawer } from "./AddToPlaylistDrawer";
import { downloadMusicTrackBatch } from "@/lib/utils/download";
import { useMusicStore } from "@/store/music-store";
import { MusicTrack } from "@/types/music";
import toast from "react-hot-toast";
import { cn, processBatchCPU } from "@/lib/utils";
import { useShallow } from "zustand/react/shallow";
import {
  getTrackIdentityKey,
  getTrackOccurrenceKeys,
} from "@/lib/utils/track-identity";

interface MusicTrackListProps {
  tracks: MusicTrack[];
  onPlay: (track: MusicTrack) => void;
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  playlistId?: string;
  currentTrackKey?: string | null;
  isPlaying?: boolean;
  onRemove?: (track: MusicTrack, silent?: boolean) => void | Promise<void>;
  onBatchRemove?: (tracks: MusicTrack[]) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loading?: boolean;
  emptyMessage?: string;
  removeLabel?: string;
  confirmRemove?: boolean;
  showSourceBadge?: boolean;
  onReorder?: (newOrder: MusicTrack[]) => void;
  showItemRemove?: boolean;
  preselectedKeys?: Set<string>;
  onSelectionModeChange?: (active: boolean) => void;
  /** Replaces the "# 标题" column labels with a custom compact header. */
  headerLead?: ReactNode;
  /** Extra buttons shown before the multi-select button in the header. */
  headerActions?: ReactNode;
}

const ROW_HEIGHT = 68;

function SortableTrackItem({
  itemKey,
  children,
}: {
  itemKey: string;
  children: React.ReactElement;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: itemKey });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? transition : undefined,
    zIndex: isDragging ? 1 : 0,
    position: "relative" as const,
    opacity: isDragging ? 0 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      {React.cloneElement(children as React.ReactElement<any>, {
        dragHandleProps: listeners,
        isSortable: true,
      })}
    </div>
  );
}

export function MusicTrackList({
  tracks,
  onPlay,
  scrollContainerRef,
  playlistId,
  currentTrackKey,
  isPlaying,
  onRemove,
  onBatchRemove,
  onLoadMore,
  hasMore,
  loading,
  emptyMessage = "暂无歌曲",
  removeLabel = "删除",
  confirmRemove,
  showSourceBadge = false,
  onReorder,
  showItemRemove = true,
  preselectedKeys,
  onSelectionModeChange,
  headerLead,
  headerActions,
}: MusicTrackListProps) {
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [isAddToPlaylistOpen, setIsAddToPlaylistOpen] = useState(false);
  const internalRef = useRef<HTMLDivElement | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const enableDnd = isSelectionMode && !!onReorder;
  const trackKeys = useMemo(() => getTrackOccurrenceKeys(tracks), [tracks]);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveKey(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveKey(null);

    if (active.id !== over?.id && onReorder) {
      const oldIndex = trackKeys.indexOf(String(active.id));
      const newIndex = trackKeys.indexOf(String(over?.id));
      if (oldIndex !== -1 && newIndex !== -1) {
        onReorder(arrayMove(tracks, oldIndex, newIndex));
      }
    }
  };

  const {
    quality,
    addBatchToFavorites,
    addBatchToNextPlay,
    showSourceBadge: storeShowBadge,
    autoMatchTrackKey,
  } = useMusicStore(
    useShallow((state) => ({
      quality: state.quality,
      addBatchToFavorites: state.addBatchToFavorites,
      addBatchToNextPlay: state.addBatchToNextPlay,
      showSourceBadge: state.showSourceBadge,
      autoMatchTrackKey: state.autoMatchContext?.trackKey ?? null,
    }))
  );

  const toggleSelect = useCallback((key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedKeys(
      selectedKeys.size === tracks.length ? new Set() : new Set(trackKeys)
    );
  }, [selectedKeys.size, trackKeys, tracks.length]);

  // 外部预选：去重等功能触发时，合并 ID 并进入选择模式
  useEffect(() => {
    if (!preselectedKeys || preselectedKeys.size === 0) return;
    setIsSelectionMode(true);
    setSelectedKeys((prev) => {
      if (prev.size === 0) return preselectedKeys;
      const merged = new Set(prev);
      preselectedKeys.forEach((key) => merged.add(key));
      return merged;
    });
  }, [preselectedKeys]);

  const resetSelection = useCallback(() => {
    setIsSelectionMode(false);
    setSelectedKeys(new Set());
    onSelectionModeChange?.(false);
  }, [onSelectionModeChange]);

  const getSelectedTracks = useCallback(
    () => tracks.filter((_track, index) => selectedKeys.has(trackKeys[index])),
    [tracks, selectedKeys, trackKeys]
  );

  const handleBatchFavorites = () => {
    const selected = getSelectedTracks();
    if (!selected.length) return;
    addBatchToFavorites(selected);
    toast.success(`已喜欢 ${selected.length} 首`);
    resetSelection();
  };

  /** 批量添加到下一首（单次 setState，无迭代） */
  const handleBatchNextPlay = () => {
    const selected = getSelectedTracks();
    if (!selected.length) return;
    addBatchToNextPlay(selected);
    toast.success(`已添加 ${selected.length} 首`);
    resetSelection();
  };

  const handleBatchRemove = async () => {
    if (!onRemove && !onBatchRemove) return;
    const count = selectedKeys.size;
    if (!confirm(`确定${removeLabel}选中的 ${count} 首歌曲吗？`)) return;

    const selected = getSelectedTracks();
    if (onBatchRemove) {
      onBatchRemove(selected);
      toast.success(`已${removeLabel} ${count} 首`);
      resetSelection();
      return;
    }

    const toastId = toast.loading(`${removeLabel}中 0/${count}`);
    await processBatchCPU(
      selected,
      (t) => onRemove!(t, true),
      (c, t) => toast.loading(`${removeLabel}中 ${c}/${t}`, { id: toastId })
    );
    toast.success(`已${removeLabel} ${count} 首`, { id: toastId });
    resetSelection();
  };

  const handleBatchDownload = async () => {
    const selected = getSelectedTracks();
    if (!selected.length) return;
    resetSelection();
    await downloadMusicTrackBatch(selected, parseInt(quality));
  };

  const dropAnimation: DropAnimation = {
    sideEffects: defaultDropAnimationSideEffects({
      styles: {
        active: {
          opacity: "0.3",
        },
      },
    }),
  };

  const virtualizer = useVirtualizer({
    count: tracks.length + 1,
    getScrollElement: () => scrollContainerRef?.current ?? internalRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  if (tracks.length === 0 && !loading) {
    return (
      <div className="flex flex-col h-full items-center justify-center text-muted-foreground/60">
        <Search className="h-8 w-8 mb-3 opacity-20" />
        <p className="text-sm">{emptyMessage}</p>
      </div>
    );
  }

  const renderHeader = () => (
    <div className="sticky top-0 z-20 border-b bg-background backdrop-blur">
      <div
        className={cn(
          "grid items-center gap-4 px-4 text-muted-foreground",
          headerLead && !isSelectionMode
            ? "h-16 grid-cols-[1fr_auto]"
            : "h-10 text-xs grid-cols-[1.75rem_1fr_auto]"
        )}
      >
        {!isSelectionMode ? (
          <>
            {headerLead ?? (
              <>
                <div className="text-center">#</div>
                <div>标题</div>
              </>
            )}
            <div
              className={cn(
                "flex items-center justify-end",
                headerLead ? "gap-0" : "gap-1"
              )}
            >
              {headerActions}
              <Button
                variant="ghost"
                size="icon"
                className={headerLead ? "h-11 w-9 text-foreground" : "h-7 w-7"}
                aria-label="多选"
                onClick={() => {
                  setIsSelectionMode(true);
                  onSelectionModeChange?.(true);
                }}
              >
                <ListChecks
                  className={headerLead ? "h-6 w-6" : "h-3.5 w-3.5"}
                />
              </Button>
            </div>
          </>
        ) : (
          <>
            {/* 第一列：全选复选框 */}
            <div className="flex justify-center">
              <Checkbox
                checked={
                  selectedKeys.size > 0 && selectedKeys.size === tracks.length
                }
                onCheckedChange={toggleSelectAll}
              />
            </div>

            {/* 第二列：已选统计和基础操作 */}
            <div className="flex items-center min-w-0 justify-between">
              <span className="text-foreground">
                已选 {selectedKeys.size} 首
              </span>
              <Button
                size="sm"
                variant="secondary"
                className="h-7 px-2 text-[11px]"
                onClick={handleBatchNextPlay}
                disabled={selectedKeys.size === 0}
              >
                <Plus className="w-3 h-3" /> 下一首
              </Button>
            </div>

            {/* 第三列：更多操作 + 确认/退出 */}
            <div className="flex items-center gap-1 justify-end">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 mr-1.5" // 对齐下方 GripVertical
                    disabled={selectedKeys.size === 0}
                    aria-label="更多批量操作"
                  >
                    <MoreVertical className="w-3.5 h-3.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent side="bottom" align="end" className="w-40 p-1">
                  <button
                    type="button"
                    className="flex min-h-11 w-full items-center rounded-sm px-2 py-1.5 text-xs hover:bg-accent"
                    onClick={handleBatchFavorites}
                  >
                    <Heart className="mr-2 h-3.5 w-3.5" /> 喜欢
                  </button>
                  <button
                    type="button"
                    className="flex min-h-11 w-full items-center rounded-sm px-2 py-1.5 text-xs hover:bg-accent"
                    onClick={handleBatchDownload}
                  >
                    <Download className="mr-2 h-3.5 w-3.5" /> 下载
                  </button>
                  <button
                    type="button"
                    className="flex min-h-11 w-full items-center rounded-sm px-2 py-1.5 text-xs hover:bg-accent"
                    onClick={() => setIsAddToPlaylistOpen(true)}
                  >
                    <ListPlus className="mr-2 h-3.5 w-3.5" /> 添加到歌单
                  </button>
                  {(onRemove || onBatchRemove) && (
                    <>
                      <div className="border-t my-1" />
                      <button
                        type="button"
                        className="flex min-h-11 w-full items-center rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-accent"
                        onClick={handleBatchRemove}
                      >
                        <Trash2 className="mr-2 h-3.5 w-3.5" /> {removeLabel}
                      </button>
                    </>
                  )}
                </PopoverContent>
              </Popover>

              {/* 退出选择模式按钮 */}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={resetSelection}
                aria-label="退出批量选择"
              >
                <Check className="w-4 h-4" />
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
  return (
    <div className="flex flex-col w-full" ref={internalRef}>
      {renderHeader()}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        id="dnd-context"
      >
        <SortableContext
          items={trackKeys}
          strategy={verticalListSortingStrategy}
          disabled={!enableDnd}
        >
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const track = tracks[item.index];
              const content = track ? (
                <MusicTrackItem
                  track={track}
                  playlistId={playlistId}
                  index={item.index}
                  isCurrent={getTrackIdentityKey(track) === currentTrackKey}
                  isPlaying={isPlaying}
                  onPlay={() => onPlay(track)}
                  showCheckbox={isSelectionMode}
                  isSelected={selectedKeys.has(trackKeys[item.index])}
                  onSelect={() => toggleSelect(trackKeys[item.index])}
                  onRemove={
                    !isSelectionMode && onRemove && showItemRemove
                      ? () => onRemove(track)
                      : undefined
                  }
                  removeLabel={removeLabel}
                  confirmRemove={confirmRemove}
                  quality={quality}
                  showSourceBadge={
                    isSelectionMode ||
                    storeShowBadge ||
                    showSourceBadge ||
                    autoMatchTrackKey === getTrackIdentityKey(track)
                  }
                />
              ) : (
                <div className="px-3 pb-20 pt-2 h-full">
                  {onLoadMore ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full text-xs text-muted-foreground h-8"
                      onClick={onLoadMore}
                      disabled={!hasMore || loading}
                    >
                      {loading ? (
                        <Loader2 className="animate-spin w-3.5 h-3.5 mr-2" />
                      ) : hasMore ? (
                        "加载更多"
                      ) : (
                        "没有更多了"
                      )}
                    </Button>
                  ) : (
                    <div className="h-full" />
                  )}
                </div>
              );

              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {track && enableDnd ? (
                    <SortableTrackItem itemKey={trackKeys[item.index]}>
                      {content}
                    </SortableTrackItem>
                  ) : (
                    content
                  )}
                </div>
              );
            })}
          </div>
        </SortableContext>
        <DragOverlay
          modifiers={[restrictToVerticalAxis, restrictToWindowEdges]}
          dropAnimation={dropAnimation}
        >
          {activeKey
            ? (() => {
                const index = trackKeys.indexOf(activeKey);
                const track = tracks[index];
                if (!track) return null;
                return (
                  <MusicTrackItem
                    track={track}
                    playlistId={playlistId}
                    index={index}
                    isCurrent={activeKey === currentTrackKey}
                    isPlaying={isPlaying}
                    onPlay={() => {}}
                    showCheckbox={isSelectionMode}
                    isSelected={selectedKeys.has(activeKey)}
                    quality={quality}
                    showSourceBadge={true}
                    dragHandleProps={{ style: { cursor: "grabbing" } }}
                    isSortable={true}
                    className="bg-background border rounded-md shadow-xl scale-105 ring-1 ring-primary/20 cursor-grabbing opacity-90"
                  />
                );
              })()
            : null}
        </DragOverlay>
      </DndContext>

      <AddToPlaylistDrawer
        open={isAddToPlaylistOpen}
        onOpenChange={setIsAddToPlaylistOpen}
        tracks={getSelectedTracks()}
        onDone={resetSelection}
      />
    </div>
  );
}
