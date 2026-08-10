import type { MusicTrack } from "@otter-music/shared";
import {
  extractRecordingVersionTraits,
  normalizeArtists,
  normalizeIdentityText,
  normalizeText,
  convertT2SOnly,
} from "@/lib/utils/music-key";

const UNKNOWN_ARTISTS = new Set([
  "unknown",
  "unknownartist",
  "variousartists",
  "未知",
  "未知歌手",
  "群星",
]);

function tokenizeEvidence(value: string): string[] {
  return convertT2SOnly(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

/**
 * Match an artist only when its complete normalized name is represented by
 * one token or a contiguous sequence of complete tokens. This admits forms
 * such as `Lady Gaga`/`LadyGaga`, while keeping short names such as `Li` from
 * matching inside `Billie`.
 */
function hasStrongArtistEvidence(
  targetArtist: string,
  evidenceFields: string[][]
): boolean {
  return evidenceFields.some((tokens) => {
    for (let start = 0; start < tokens.length; start++) {
      let joined = "";
      for (let end = start; end < tokens.length; end++) {
        joined += tokens[end];
        if (joined === targetArtist) return true;
        if (joined.length >= targetArtist.length) break;
      }
    }
    return false;
  });
}

function findCompleteTokenSequence(
  target: string,
  tokens: string[]
): { start: number; end: number } | null {
  for (let start = 0; start < tokens.length; start++) {
    let joined = "";
    for (let end = start; end < tokens.length; end++) {
      joined += tokens[end];
      if (joined === target) return { start, end };
      if (joined.length >= target.length) break;
    }
  }
  return null;
}

const TITLE_NOISE_TOKENS = new Set([
  "official",
  "audio",
  "video",
  "music",
  "mv",
  "lyric",
  "lyrics",
  "visualizer",
  "original",
  "version",
  "full",
  "hd",
  "uhd",
  "hq",
  "flac",
  "wav",
  "live",
  "remix",
  "acoustic",
  "instrumental",
  "cover",
  "demo",
  "remaster",
  "remastered",
  "edit",
  "reverb",
  "nightcore",
  "by",
  "官方",
  "音频",
  "音乐",
  "视频",
  "歌词",
  "原版",
  "原曲",
  "完整版",
  "高音质",
  "无损",
  "纯享",
  "字幕",
  "中英字幕",
  "单曲",
  "首发",
  "现场",
  "翻唱",
  "伴奏",
  "重制",
]);

function isKnownTitleNoise(token: string): boolean {
  return (
    TITLE_NOISE_TOKENS.has(token) ||
    /^(?:19|20)\d{2}$/u.test(token) ||
    /^\d{3,4}p$/iu.test(token) ||
    /^\d{2,4}kbps$/iu.test(token) ||
    /^(?:4k|8k)$/iu.test(token)
  );
}

function markCompleteIdentitySequences(
  tokens: string[],
  identities: string[],
  explained: boolean[]
): void {
  for (const identity of identities) {
    if (!identity) continue;
    for (let start = 0; start < tokens.length; start++) {
      let joined = "";
      for (let end = start; end < tokens.length; end++) {
        joined += tokens[end];
        if (joined === identity) {
          for (let index = start; index <= end; index++) {
            explained[index] = true;
          }
          break;
        }
        if (joined.length >= identity.length) break;
      }
    }
  }
}

const BRACKETED_TITLE_CONTENT = /[([{【（]([^\])}】）]*)[\])}】）]/gu;
const VERSION_ANNOTATION_TOKENS = new Set([
  "live",
  "remix",
  "remixed",
  "mix",
  "acoustic",
  "unplugged",
  "instrumental",
  "karaoke",
  "off",
  "vocal",
  "cover",
  "demo",
  "remaster",
  "remastered",
  "re",
  "recorded",
  "recording",
  "radio",
  "edit",
  "sped",
  "up",
  "slowed",
  "reverb",
  "reverbed",
  "nightcore",
  "feat",
  "featuring",
  "ft",
  "duet",
  "version",
  "ver",
  "by",
  "现场",
  "现场版",
  "演唱会",
  "实况",
  "混音",
  "不插电",
  "伴奏",
  "伴唱",
  "纯音乐",
  "无人声",
  "翻唱",
  "翻自",
  "样带",
  "重制",
  "重新录制",
  "剪辑版",
  "加速版",
  "慢速版",
  "混响版",
  "合作版",
  "合唱",
  "合唱版",
  "对唱",
  "对唱版",
]);

function isRecordingVersionAnnotation(
  content: string,
  targetArtists: string[]
): boolean {
  if (extractRecordingVersionTraits(content).tags.length === 0) return false;
  const tokens = tokenizeEvidence(content);
  const explained = tokens.map(() => false);
  markCompleteIdentitySequences(tokens, targetArtists, explained);
  return tokens.every(
    (token, index) =>
      explained[index] ||
      VERSION_ANNOTATION_TOKENS.has(token) ||
      /^(?:19|20)\d{2}$/u.test(token)
  );
}

/**
 * Preserve parenthetical title identity (`Part II`, `Reprise`, translations),
 * while leaving recording-version annotations to the global version gate.
 */
function normalizeTargetTitleIdentity(
  title: string,
  targetArtists: string[]
): string {
  const withIdentityParentheses = title.replace(
    BRACKETED_TITLE_CONTENT,
    (whole, content: string) =>
      isRecordingVersionAnnotation(content, targetArtists) ? " " : ` ${whole} `
  );
  return normalizeIdentityText(withIdentityParentheses).replace(/\s+/gu, "");
}

const SEQUEL_PREFIXES = new Set([
  "part",
  "pt",
  "chapter",
  "episode",
  "ep",
  "volume",
  "vol",
  "season",
]);

function isSequelNumberToken(value: string | undefined): boolean {
  if (!value) return false;
  return (
    /^\d+[a-z]?$/u.test(value) ||
    /^(?:ii|iii|iv|v|vi|vii|viii|ix|x)$/iu.test(value) ||
    /^第?[一二三四五六七八九十百]+(?:部|章|集|季)?$/u.test(value)
  );
}

/**
 * Require the target title as a complete token sequence. A plain substring
 * admitted `Song 2` for `Song`; a numeric/part suffix immediately following
 * the matched title is an explicit sequel identity and must be rejected.
 */
function hasStrongTitleEvidence(
  targetName: string,
  title: string,
  knownIdentities: string[]
): boolean {
  const tokens = tokenizeEvidence(title);
  const match = findCompleteTokenSequence(targetName, tokens);
  if (!match) return false;

  const next = tokens[match.end + 1];
  const nextAfterPrefix = tokens[match.end + 2];
  if (isSequelNumberToken(next)) return false;
  if (
    next &&
    SEQUEL_PREFIXES.has(next) &&
    isSequelNumberToken(nextAfterPrefix)
  ) {
    return false;
  }

  // A token boundary alone is insufficient: `Song` is a complete token in
  // both `My Song` and `Song Again`. Explain every remaining token as the
  // target artist/album or narrowly scoped video metadata; otherwise fail
  // closed instead of treating a longer, different title as the same song.
  const explained = tokens.map(
    (_token, index) => index >= match.start && index <= match.end
  );
  markCompleteIdentitySequences(tokens, knownIdentities, explained);
  return tokens.every(
    (token, index) => explained[index] || isKnownTitleNoise(token)
  );
}

export function createAutoMatchPredicate(target: MusicTrack) {
  const targetArtists = normalizeArtists(target.artist);
  const targetName = normalizeTargetTitleIdentity(target.name, targetArtists);
  const targetAlbum = normalizeText(target.album || "");
  const hasUnreliableArtist =
    targetArtists.length === 0 ||
    targetArtists.some((artist) => UNKNOWN_ARTISTS.has(artist));

  return (candidate: MusicTrack) => {
    if (!targetName || hasUnreliableArtist) return false;

    const candidateFields = [
      candidate.name,
      ...candidate.artist,
      candidate.album || "",
    ];
    const evidenceFields = candidateFields.map(tokenizeEvidence);

    const nameMatch = hasStrongTitleEvidence(targetName, candidate.name, [
      ...targetArtists,
      targetAlbum,
    ]);
    const everyArtistMatches = targetArtists.every((targetArtist) =>
      hasStrongArtistEvidence(targetArtist, evidenceFields)
    );

    if (!nameMatch) return false;
    if (!everyArtistMatches) return false;

    return true;
  };
}
