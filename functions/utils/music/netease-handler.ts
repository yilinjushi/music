import { search, getSongDetail, getLyric } from "./netease-api";
import type { Context } from "hono";
import type { Env } from "../../types/hono";
import { FUNCTION_LOG_EVENTS, logFunctionError } from "../security-logger";

const PRIVATE_NO_STORE = "private, no-store, max-age=0";
const LEGACY_AUDIO_KEYS = new Set(["types", "type", "source", "id", "br"]);
const LEGACY_AUDIO_BITRATES = new Set([128000, 192000, 320000, 999000]);

function parseLegacyAudioDescriptor(
  requestUrl: string
): { id: string; br: number } | null {
  const params = new URL(requestUrl).searchParams;
  if ([...params.keys()].some((key) => !LEGACY_AUDIO_KEYS.has(key))) {
    return null;
  }
  const types = params.getAll("types");
  const type = params.getAll("type");
  if (
    types.length + type.length !== 1 ||
    (types[0] ?? type[0])?.toLowerCase() !== "url" ||
    params.getAll("source").length !== 1 ||
    params.get("source") !== "_netease" ||
    params.getAll("id").length !== 1 ||
    params.getAll("br").length > 1
  ) {
    return null;
  }

  const id = (params.get("id") || "").replace(/^(?:netrack_|ne_track_)/, "");
  const rawBr = params.get("br") ?? "192";
  const parsedBr = /^\d{3,6}$/.test(rawBr) ? Number(rawBr) : NaN;
  const br = parsedBr < 1000 ? parsedBr * 1000 : parsedBr;
  return /^\d{1,20}$/.test(id) && LEGACY_AUDIO_BITRATES.has(br)
    ? { id, br }
    : null;
}

function legacyAudioPath(id: string, br: number): string {
  return `/music-api/netease/audio?${new URLSearchParams({
    id,
    br: String(br),
  }).toString()}`;
}

export async function handleNeteaseRequest(
  c: Context<{ Bindings: Env }>,
  query: Record<string, string>
) {
  try {
    const type = (query.types ?? query.type ?? "").toLowerCase();

    // This legacy public adapter never accepts account credentials from the
    // browser. Authenticated operations use the dedicated session routes.
    const cookie = "";

    if (type === "search") {
      const name = query.name || "";
      const page = parseInt(query.pages || "1");
      const count = parseInt(query.count || "20");

      const res = await search(name, 1, page, count, cookie);

      // Map to Meting-like format expected by frontend
      if (res.data.result && res.data.result.songs) {
        const list = res.data.result.songs.map((s: any) => ({
          id: s.id,
          name: s.name,
          artist: s.artists.map((a: any) => a.name),
          album: s.album.name,
          pic: s.album.picUrl, // Direct URL
          source: "_netease",
          url_id: s.id,
          pic_id: s.id,
          lyric_id: s.id,
        }));
        return c.json(list);
      }
      return c.json([]);
    }

    if (type === "url") {
      c.header("Cache-Control", PRIVATE_NO_STORE);
      c.header("Pragma", "no-cache");
      const descriptor = parseLegacyAudioDescriptor(c.req.url);
      if (!descriptor) {
        return c.json({ error: "Invalid audio request" }, 400);
      }
      return c.json({
        url: legacyAudioPath(descriptor.id, descriptor.br),
        br: descriptor.br,
        size: 0,
      });
    }

    if (type === "pic") {
      const id = query.id || "";
      // Fix: frontend passes URL as ID for imported tracks
      if (id.startsWith("http")) {
        return c.json({ url: id });
      }

      const res = await getSongDetail(id, cookie);
      if (res && res.al) {
        return c.json({
          url: res.al.picUrl,
        });
      }
      return c.json({ url: "" });
    }

    if (type === "lyric") {
      const id = query.id || "";
      const res = await getLyric(id, cookie);
      return c.json({
        lyric: res.data.lrc?.lyric || "",
        tlyric: res.data.tlyric?.lyric || "",
      });
    }
  } catch (e: any) {
    logFunctionError(FUNCTION_LOG_EVENTS.NETEASE_LEGACY_HANDLER_FAILED);
    return c.json({ error: e.message }, 500);
  }
}
