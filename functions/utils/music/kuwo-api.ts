import {
  fetchKuwoPlaylistDetail as fetchKuwoPlaylistPages,
  fetchUpstreamWithDeadline,
  KUWO_MAX_PLAYLIST_PAGES,
  KUWO_PAGE_SIZE,
  KUWO_PLAYLIST_WALL_CLOCK_MS,
  type KuwoPlaylistDetail,
  type UpstreamResponseType,
} from "@otter-music/shared";

export { KUWO_PAGE_SIZE };

const KUWO_BASE_URL = "http://nplserver.kuwo.cn";
const KUWO_PLAYLIST_MAX_REQUESTS = KUWO_MAX_PLAYLIST_PAGES;
const KUWO_PLAYLIST_REQUEST_DEADLINE_MS = 4_000;

interface PlaylistUpstreamBudget {
  deadline: number;
  requests: number;
}

function createPlaylistUpstreamBudget(): PlaylistUpstreamBudget {
  return {
    deadline: Date.now() + KUWO_PLAYLIST_WALL_CLOCK_MS,
    requests: 0,
  };
}

async function fetchPlaylistUpstream<T>(
  budget: PlaylistUpstreamBudget,
  input: RequestInfo | URL,
  init: RequestInit,
  read: (response: Response) => Promise<T> | T,
  responseType: UpstreamResponseType
): Promise<T> {
  const remainingMs = budget.deadline - Date.now();
  if (budget.requests >= KUWO_PLAYLIST_MAX_REQUESTS || remainingMs <= 0) {
    throw new Error("Kuwo playlist upstream budget exceeded");
  }
  budget.requests += 1;
  return fetchUpstreamWithDeadline(input, init, read, {
    responseType,
    deadlineMs: Math.min(remainingMs, KUWO_PLAYLIST_REQUEST_DEADLINE_MS),
  });
}

export async function fetchKuwoPlaylistDetail(
  playlistId: string
): Promise<KuwoPlaylistDetail> {
  const budget = createPlaylistUpstreamBudget();
  return fetchKuwoPlaylistPages(playlistId, async (path) => {
    return fetchPlaylistUpstream(
      budget,
      `${KUWO_BASE_URL}${path}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      },
      async (response) => {
        if (!response.ok) throw new Error(`Kuwo API error: ${response.status}`);
        return response.text();
      },
      "text"
    );
  });
}
