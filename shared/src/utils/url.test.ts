import { describe, expect, it } from "vitest";
import { normalizePersistableResourceUrl } from "./url";

describe("normalizePersistableResourceUrl", () => {
  it("upgrades trusted public resources and removes presentation state", () => {
    expect(
      normalizePersistableResourceUrl(
        "http://p1.music.126.net/avatar.jpg?param=200y200#preview"
      )
    ).toBe("https://p1.music.126.net/avatar.jpg");
    expect(
      normalizePersistableResourceUrl("//imge.kugou.com/cover.jpg?size=300")
    ).toBe("https://imge.kugou.com/cover.jpg");
  });

  it("fails closed for active, credentialed or malformed references", () => {
    expect(normalizePersistableResourceUrl("javascript:alert(1)")).toBe("");
    expect(
      normalizePersistableResourceUrl("https://user:pass@cdn.example/a.jpg")
    ).toBe("");
    expect(normalizePersistableResourceUrl("/relative.jpg")).toBe("");
    expect(
      normalizePersistableResourceUrl("https://cdn.example/a.jpg\nnext")
    ).toBe("");
  });
});
