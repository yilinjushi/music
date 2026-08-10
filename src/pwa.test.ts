import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pwaManifest } from "../pwa.config";
import {
  BILIBILI_AUDIO_HOST_SUFFIXES,
  isHttpsUrlOnAllowedHost,
} from "../dev-proxy-policy";

const projectFile = (path: string) => resolve(process.cwd(), path);

function readPngDimensions(path: string) {
  const png = readFileSync(projectFile(path));
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

describe("PWA install contract", () => {
  it("has a stable identity and valid 192/512/maskable PNG assets", () => {
    expect(pwaManifest.id).toBe("/");
    expect(pwaManifest.display).toBe("standalone");
    expect(pwaManifest.start_url).toBe("/");
    expect(pwaManifest.scope).toBe("/");

    const icons = pwaManifest.icons ?? [];
    expect(icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: "192x192", purpose: "any" }),
        expect.objectContaining({ sizes: "512x512", purpose: "any" }),
        expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
      ])
    );

    for (const icon of icons) {
      const expectedSize = Number((icon.sizes ?? "0x0").split("x")[0]);
      expect(readPngDimensions(`public${icon.src}`)).toEqual({
        width: expectedSize,
        height: expectedSize,
      });
    }
  });

  it("uses a user prompt instead of automatically activating updates", () => {
    const viteConfig = readFileSync(projectFile("vite.config.ts"), "utf8");
    expect(viteConfig).toContain('registerType: "prompt"');
    expect(viteConfig).toContain("injectRegister: null");
    expect(viteConfig).not.toContain('registerType: "autoUpdate"');
  });

  it("keeps page zoom enabled for mobile accessibility", () => {
    const html = readFileSync(projectFile("index.html"), "utf8");
    expect(html).toContain("viewport-fit=cover");
    expect(html).not.toMatch(/maximum-scale|user-scalable\s*=\s*no/i);
  });

  it("does not ship the removed native Media Session bridge", () => {
    const packageJson = readFileSync(projectFile("package.json"), "utf8");
    const packageLock = readFileSync(projectFile("package-lock.json"), "utf8");

    expect(packageJson).not.toContain("@jofr/capacitor-media-session");
    expect(packageLock).not.toContain("@jofr/capacitor-media-session");
  });
});

describe("service-worker policy", () => {
  const source = readFileSync(projectFile("src/sw.ts"), "utf8");

  it("falls back to a precached application shell for offline deep links", () => {
    expect(source).toContain("new NavigationRoute");
    expect(source).toContain("matchPrecache(APP_SHELL_URL)");
    expect(source).toContain('const APP_SHELL_URL = "/index.html"');
  });

  it("does not install a runtime audio cache or cache partial responses", () => {
    expect(source).not.toContain("workbox-strategies");
    expect(source).not.toContain("CacheFirst(");
    expect(source).not.toContain("CacheableResponsePlugin");
  });

  it("does not expose legacy stream-cache records as offline audio", () => {
    const eventHandlers = readFileSync(
      projectFile("src/hooks/useAudioEventHandlers.ts"),
      "utf8"
    );
    const resolver = readFileSync(
      projectFile("src/lib/audio-resolver.ts"),
      "utf8"
    );
    const minePage = readFileSync(
      projectFile("src/components/MinePage.tsx"),
      "utf8"
    );
    const settingsPage = readFileSync(
      projectFile("src/components/SettingsPage.tsx"),
      "utf8"
    );

    expect(eventHandlers).not.toContain("useOfflineStore");
    expect(eventHandlers).not.toContain('source: "stream-cache"');
    expect(resolver).not.toContain("useOfflineStore");
    expect(minePage).not.toContain("__offline__");
    expect(settingsPage).not.toContain("StreamCacheSetting");
  });

  it("only skips waiting after an explicit page message", () => {
    expect(source).toContain('event.data?.type === "SKIP_WAITING"');
    expect(source).not.toContain("clientsClaim");
  });
});

describe("production content security policy", () => {
  const headers = readFileSync(projectFile("public/_headers"), "utf8");
  const csp = headers.match(/Content-Security-Policy:\s*([^\r\n]+)/)?.[1] ?? "";
  const directives = new Map(
    csp
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...sources] = part.split(/\s+/);
        return [name, sources] as const;
      })
  );
  const artworkHosts = [
    "https://p.qpic.cn",
    "https://img1.kuwo.cn",
    "https://img2.kuwo.cn",
    "https://img3.kuwo.cn",
    "https://img4.kuwo.cn",
  ];
  const forbiddenHosts = [
    "https://qq.com",
    "https://*.qq.com",
    "https://qpic.cn",
    "https://*.qpic.cn",
    "https://kuwo.cn",
    "https://*.kuwo.cn",
    "https://evil.p.qpic.cn",
    "https://p.qpic.cn.attacker.test",
    "https://img1.kuwo.cn.attacker.test",
  ];

  it.each(["img-src", "connect-src"])(
    "%s allows only the observed QQ and Kuwo artwork hosts",
    (directive) => {
      const sources = directives.get(directive) ?? [];
      expect(sources).toEqual(expect.arrayContaining(artworkHosts));
      for (const forbidden of forbiddenHosts) {
        expect(sources).not.toContain(forbidden);
      }
    }
  );
});

describe("development proxy policy", () => {
  it("accepts only HTTPS Bilibili CDN audio targets", () => {
    expect(
      isHttpsUrlOnAllowedHost(
        "https://upos-sz-mirrorcos.bilivideo.com/audio.m4s",
        BILIBILI_AUDIO_HOST_SUFFIXES
      )
    ).toBe(true);
    expect(
      isHttpsUrlOnAllowedHost(
        "http://upos-sz-mirrorcos.bilivideo.com/audio.m4s",
        BILIBILI_AUDIO_HOST_SUFFIXES
      )
    ).toBe(false);
    expect(
      isHttpsUrlOnAllowedHost(
        "https://bilivideo.com.evil.example/audio.m4s",
        BILIBILI_AUDIO_HOST_SUFFIXES
      )
    ).toBe(false);
    expect(
      isHttpsUrlOnAllowedHost(
        "https://127.0.0.1/audio.m4s",
        BILIBILI_AUDIO_HOST_SUFFIXES
      )
    ).toBe(false);
  });

  it("does not expose the former arbitrary fetch proxy or wildcard CORS", () => {
    const viteConfig = readFileSync(projectFile("vite.config.ts"), "utf8");
    expect(viteConfig).not.toContain('"/api/fetch"');
    expect(viteConfig).not.toContain('"Access-Control-Allow-Origin", "*"');
  });

  it("does not forward browser-controlled NetEase credentials", () => {
    const viteConfig = readFileSync(projectFile("vite.config.ts"), "utf8");
    expect(viteConfig).not.toContain('"/api/netease"');
    expect(viteConfig).not.toContain("x-real-cookie");
  });
});
