import { MarketPlaylist } from "@/lib/netease/netease-types";
import { MusicCover } from "@/components/MusicCover";

interface PlaylistGridProps {
  list: MarketPlaylist[];
  onClick: (id: string) => void;
}

export const PlaylistGrid = ({ list, onClick }: PlaylistGridProps) => (
  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-x-3 gap-y-4">
    {list.map((item) => (
      <button
        type="button"
        key={item.id}
        className="group flex min-h-11 flex-col gap-2.5 text-left transition-all hover:translate-y-[-4px]"
        onClick={() => onClick(item.id)}
        aria-label={`打开歌单：${item.name}`}
      >
        <div className="relative aspect-square overflow-hidden rounded-md shadow-md ring-1 ring-black/5 transition-shadow hover:shadow-xl">
          <MusicCover
            src={item.coverUrl}
            alt={item.name}
            className="transition-transform duration-500 group-hover:scale-110"
          />
        </div>
        <div className="px-0.5">
          <h3 className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground/80 transition-colors group-hover:text-primary">
            {item.name}
          </h3>
        </div>
      </button>
    ))}
  </div>
);
