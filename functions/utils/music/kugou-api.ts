import {
  buildKugouAndroidHeaders,
  buildKugouDeviceRegistrationPayload,
  convertKugouSongToMusicTrack,
  fetchKugouGlobalPlaylistPages,
  fetchKugouPlaylistPages,
  isKugouGlobalCollectionId,
  KUGOU_MAX_PLAYLIST_PAGES,
  KUGOU_PAGE_SIZE,
  KUGOU_PLAYLIST_WALL_CLOCK_MS,
  parseKugouDeviceRegistrationResponse,
  withKugouPlaylistMeta,
  fetchUpstreamWithDeadline,
  type KugouPlaylistDetail,
  type UpstreamResponseType,
} from "@otter-music/shared";

export { KUGOU_PAGE_SIZE, convertKugouSongToMusicTrack };

const KUGOU_BASE_URL = "http://mobilecdn.kugou.com";
const KUGOU_PLAYLIST_MAX_REQUESTS = KUGOU_MAX_PLAYLIST_PAGES + 2;
const KUGOU_PLAYLIST_REQUEST_DEADLINE_MS = 4_000;
let deviceMid: string | null = null;
let deviceDfid = "-";

interface PlaylistUpstreamBudget {
  deadline: number;
  requests: number;
}

function createPlaylistUpstreamBudget(): PlaylistUpstreamBudget {
  return {
    deadline: Date.now() + KUGOU_PLAYLIST_WALL_CLOCK_MS,
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
  if (budget.requests >= KUGOU_PLAYLIST_MAX_REQUESTS || remainingMs <= 0) {
    throw new Error("Kugou playlist upstream budget exceeded");
  }
  budget.requests += 1;
  return fetchUpstreamWithDeadline(input, init, read, {
    responseType,
    deadlineMs: Math.min(remainingMs, KUGOU_PLAYLIST_REQUEST_DEADLINE_MS),
  });
}

/**
 * 获取服务端酷狗设备 ID，并避免在 Cloudflare 全局作用域生成随机值。
 */
function getServerDeviceMid(): string {
  if (!deviceMid) {
    deviceMid = crypto.randomUUID().replace(/-/g, "");
  }
  return deviceMid;
}

/**
 * 注册服务端酷狗设备并返回 dfid。
 */
async function registerServerDevice(
  mid: string,
  budget: PlaylistUpstreamBudget
): Promise<string> {
  const payload = await buildKugouDeviceRegistrationPayload(mid);

  const raw = await fetchPlaylistUpstream(
    budget,
    payload.url,
    {
      method: "POST",
      headers: payload.headers,
      body: payload.body,
    },
    async (response) => {
      if (!response.ok)
        throw new Error(`Kugou device register failed: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    "binary"
  );
  const { dfid } = await parseKugouDeviceRegistrationResponse(
    raw,
    payload.encryptKey,
    payload.iv
  );
  return dfid;
}

/**
 * 获取服务端酷狗 dfid，并在 Worker 实例内复用注册结果。
 */
async function ensureServerDeviceDfid(
  mid: string,
  budget: PlaylistUpstreamBudget
): Promise<string> {
  if (deviceDfid === "-") {
    deviceDfid = await registerServerDevice(mid, budget);
  }
  return deviceDfid;
}

// ============================================================
// 歌单获取（直接 fetch + 调用 shared 核心算法）
// ============================================================

export async function fetchKugouPlaylistDetail(
  playlistId: string
): Promise<KugouPlaylistDetail> {
  const budget = createPlaylistUpstreamBudget();
  if (isKugouGlobalCollectionId(playlistId)) {
    const mid = getServerDeviceMid();
    const dfid = await ensureServerDeviceDfid(mid, budget);

    return fetchKugouGlobalPlaylistPages(
      playlistId,
      dfid,
      mid,
      async (url) => {
        return fetchPlaylistUpstream(
          budget,
          url,
          { headers: buildKugouAndroidHeaders(url, dfid, mid) },
          async (response) => {
            if (!response.ok)
              throw new Error(`Kugou API error: ${response.status}`);
            return response.text();
          },
          "text"
        );
      },
      async (url, body) => {
        return fetchPlaylistUpstream(
          budget,
          url,
          {
            method: "POST",
            headers: {
              ...buildKugouAndroidHeaders(url, dfid, mid),
              "Content-Type": "application/json",
            },
            body,
          },
          (response) => (response.ok ? response.text() : null),
          "text"
        );
      }
    );
  }

  const detail = await fetchKugouPlaylistPages(playlistId, async (path) => {
    return fetchPlaylistUpstream(
      budget,
      `${KUGOU_BASE_URL}${path}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      },
      async (response) => {
        if (!response.ok)
          throw new Error(`Kugou API error: ${response.status}`);
        return response.text();
      },
      "text"
    );
  });
  return withKugouPlaylistMeta(playlistId, detail, async (url) => {
    return fetchPlaylistUpstream(
      budget,
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      },
      (response) => (response.ok ? response.text() : null),
      "text"
    );
  });
}

// ============================================================
// 短链解析
// ============================================================

export async function resolveKugouShortUrl(
  shortUrl: string
): Promise<string | null> {
  return fetchUpstreamWithDeadline(
    shortUrl,
    { method: "HEAD", redirect: "manual" },
    (response) => response.headers.get("location"),
    { responseType: "none" }
  );
}
