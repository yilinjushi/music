import { beforeEach, describe, expect, it } from "vitest";
import {
  ALBUM_SHEET_RESTORE_SESSION_KEY,
  ALBUM_SHEET_RESTORE_SESSION_VERSION,
  consumeAlbumSheetRestoreSession,
  createArtistAlbumSheetState,
  getArtistAlbumSheetBackTarget,
  purgeLegacyAlbumSheetRestoreSession,
  setAlbumSheetRestoreSession,
  shouldRestoreArtistAlbumSheet,
} from "@/lib/navigation/netease-detail-navigation";

describe("netease detail navigation helpers", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("creates artist album sheet navigation state", () => {
    expect(createArtistAlbumSheetState("123", "Artist")).toEqual({
      from: "artist-album-sheet",
      artistId: "123",
      artistName: "Artist",
      restoreAlbumSheet: true,
    });
  });

  it("restores artist album sheet only for matching artist route", () => {
    const state = createArtistAlbumSheetState("123", "Artist");

    expect(shouldRestoreArtistAlbumSheet("artist", "123", state)).toBe(true);
    expect(shouldRestoreArtistAlbumSheet("artist", "456", state)).toBe(false);
    expect(shouldRestoreArtistAlbumSheet("album", "123", state)).toBe(false);
    expect(shouldRestoreArtistAlbumSheet("artist", null, state)).toBe(false);
  });

  it("returns explicit back target only for album pages opened from artist sheet", () => {
    const state = createArtistAlbumSheetState("123", "Artist");

    expect(getArtistAlbumSheetBackTarget("album", state)).toEqual({
      artistId: "123",
      artistName: "Artist",
    });
    expect(getArtistAlbumSheetBackTarget("artist", state)).toBeNull();
    expect(getArtistAlbumSheetBackTarget("album", null)).toBeNull();
  });

  it("writes and consumes only the explicit versioned restore schema", () => {
    expect(setAlbumSheetRestoreSession("123", "Artist")).toBe(true);
    const raw = sessionStorage.getItem(ALBUM_SHEET_RESTORE_SESSION_KEY) ?? "";
    expect(JSON.parse(raw)).toEqual({
      version: ALBUM_SHEET_RESTORE_SESSION_VERSION,
      artistId: "123",
      artistName: "Artist",
    });

    expect(consumeAlbumSheetRestoreSession()).toEqual({
      artistId: "123",
      artistName: "Artist",
    });
    expect(sessionStorage.getItem(ALBUM_SHEET_RESTORE_SESSION_KEY)).toBeNull();
  });

  it.each([
    ["", "Artist"],
    ["not-numeric", "Artist"],
    ["1".repeat(33), "Artist"],
    ["123", "X-Auth-Token=artist-name-canary"],
    ["123", "x".repeat(257)],
  ])("rejects an unsafe restore write: %s / %s", (artistId, artistName) => {
    expect(setAlbumSheetRestoreSession("456", "Previously safe")).toBe(true);
    expect(setAlbumSheetRestoreSession(artistId, artistName)).toBe(false);
    const raw = sessionStorage.getItem(ALBUM_SHEET_RESTORE_SESSION_KEY);
    expect(raw).toBeNull();
  });

  it("deletes current-version pollution while consuming", () => {
    sessionStorage.setItem(
      ALBUM_SHEET_RESTORE_SESSION_KEY,
      JSON.stringify({
        version: ALBUM_SHEET_RESTORE_SESSION_VERSION,
        artistId: "123",
        artistName: "Artist",
        x_api_key: "current-version-canary",
      })
    );

    expect(consumeAlbumSheetRestoreSession()).toBeNull();
    expect(sessionStorage.getItem(ALBUM_SHEET_RESTORE_SESSION_KEY)).toBeNull();
  });

  it("rejects an unversioned record even under the v2 key", () => {
    sessionStorage.setItem(
      ALBUM_SHEET_RESTORE_SESSION_KEY,
      JSON.stringify({ artistId: "123", artistName: "legacy-canary" })
    );
    expect(consumeAlbumSheetRestoreSession()).toBeNull();
    expect(sessionStorage.getItem(ALBUM_SHEET_RESTORE_SESSION_KEY)).toBeNull();
  });

  it("purges the old fixed session key without deleting a clean v2 record", () => {
    sessionStorage.setItem(
      "netease-album-sheet-restore",
      JSON.stringify({ artistId: "123", cookie: "legacy-canary" })
    );
    expect(setAlbumSheetRestoreSession("456", "Safe Artist")).toBe(true);
    // Recreate the legacy value to prove the standalone bootstrap purge.
    sessionStorage.setItem("netease-album-sheet-restore", "legacy-canary");

    purgeLegacyAlbumSheetRestoreSession();

    expect(sessionStorage.getItem("netease-album-sheet-restore")).toBeNull();
    expect(
      sessionStorage.getItem(ALBUM_SHEET_RESTORE_SESSION_KEY)
    ).not.toBeNull();
  });
});
