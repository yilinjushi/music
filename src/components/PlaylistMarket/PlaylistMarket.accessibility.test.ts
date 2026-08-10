import { describe, expect, it } from "vitest";

import { PLAYLIST_MARKET_ROOT_CLASS_NAME } from "./PlaylistMarket";

describe("PlaylistMarket accessibility", () => {
  it("keeps the page fully opaque while foreground text is visible", () => {
    expect(PLAYLIST_MARKET_ROOT_CLASS_NAME).not.toMatch(
      /(?:^|\s)(?:animate-in|fade-in(?:-\S*)?|opacity-\S+)(?:\s|$)/
    );
  });
});
