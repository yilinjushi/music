import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BASELINE_PROJECT = "mobile-390x844";
const TOUCH_TARGET_SELECTOR = [
  "button",
  "a[href]",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "[role=button]",
  "[role=switch]",
  "[role=checkbox]",
  "[role=slider]",
  "[role=tab]",
].join(", ");

type SessionMode = "anonymous" | "authenticated" | "expired";
type MockApiOptions = {
  session?: SessionMode;
  onLogout?: () => void;
  autoMatchFixture?: {
    onPrimaryUrlRequest?: (id: string) => void;
    onSearch?: () => void;
    onSecondaryUrlRequest?: (id: string) => void;
  };
};

type HealthState = {
  issues: string[];
  allowedRequestFailures: RegExp[];
  allowedConsoleErrors: RegExp[];
};

const pageHealth = new WeakMap<Page, HealthState>();
const replacedWorkerFiles = new Map<string, string>();

const simulatedProfile = {
  userId: 42001,
  nickname: "模拟会话用户",
  avatarUrl: "",
};

const fixtureTracks = [
  {
    id: "fixture-track-1",
    name: "测试曲目一",
    artist: ["测试歌手"],
    album: "浏览器测试专辑",
    pic_id: "",
    url_id: "/e2e-media/track-1.wav",
    lyric_id: "",
    source: "url",
    update_time: 1,
    is_deleted: false,
  },
  {
    id: "fixture-track-2",
    name: "测试曲目二",
    artist: ["测试歌手"],
    album: "浏览器测试专辑",
    pic_id: "",
    url_id: "/e2e-media/track-2.wav",
    lyric_id: "",
    source: "url",
    update_time: 2,
    is_deleted: false,
  },
] as const;

function createSilentWav(durationSeconds = 60, sampleRate = 8_000) {
  const dataSize = durationSeconds * sampleRate;
  const wav = Buffer.alloc(44 + dataSize, 128);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

const wavSilence = createSilentWav();

function onlyBaseline(testInfo: TestInfo) {
  test.skip(
    testInfo.project.name !== BASELINE_PROJECT,
    "One mobile Chromium viewport is sufficient for this stateful contract"
  );
}

function safeRequestLabel(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return rawUrl.split(/[?#]/, 1)[0];
  }
}

function monitorPageHealth(page: Page) {
  const state: HealthState = {
    issues: [],
    allowedRequestFailures: [],
    allowedConsoleErrors: [],
  };
  pageHealth.set(page, state);

  page.on("pageerror", (error) => {
    state.issues.push(`pageerror: ${error.name}: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (state.allowedConsoleErrors.some((pattern) => pattern.test(text)))
      return;
    state.issues.push(`console.error: ${text}`);
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown failure";
    if (/ERR_ABORTED|NS_BINDING_ABORTED/i.test(failure)) return;
    const label = safeRequestLabel(request.url());
    if (
      state.allowedRequestFailures.some(
        (pattern) => pattern.test(label) || pattern.test(failure)
      )
    ) {
      return;
    }
    state.issues.push(
      `requestfailed: ${request.method()} ${label} (${failure})`
    );
  });
  page.on("response", (response) => {
    if (response.status() < 500) return;
    state.issues.push(
      `response ${response.status()}: ${response.request().method()} ${safeRequestLabel(response.url())}`
    );
  });
}

function allowRequestFailures(page: Page, ...patterns: RegExp[]) {
  pageHealth.get(page)?.allowedRequestFailures.push(...patterns);
}

function allowConsoleErrors(page: Page, ...patterns: RegExp[]) {
  pageHealth.get(page)?.allowedConsoleErrors.push(...patterns);
}

test.beforeEach(async ({ page }) => {
  monitorPageHealth(page);
});

test.afterEach(async ({ page }, testInfo) => {
  await Promise.all(
    [...replacedWorkerFiles].map(async ([fixturePath, originalSource]) => {
      await writeFile(fixturePath, originalSource, "utf8");
      replacedWorkerFiles.delete(fixturePath);
    })
  );
  if (testInfo.status === "skipped") return;
  await page.waitForTimeout(50);
  expect(
    pageHealth.get(page)?.issues ?? [],
    "The page emitted an unexpected runtime, console, request, or 5xx error"
  ).toEqual([]);
});

function musicStatePayload(
  playlists: unknown[] = [],
  queue: unknown[] = [],
  options: {
    enableAutoMatch?: boolean;
    enableProxyFallback?: boolean;
    sourceConfigs?: unknown[];
  } = {}
) {
  return JSON.stringify({
    state: {
      playlists,
      queue,
      currentIndex: 0,
      currentAudioTime: 0,
      isShuffle: false,
      searchSource: "_netease",
      enableAutoMatch: options.enableAutoMatch ?? false,
      enableProxyFallback: options.enableProxyFallback ?? false,
      ...(options.sourceConfigs
        ? { sourceConfigs: options.sourceConfigs }
        : {}),
    },
    version: 0,
  });
}

function sessionStatePayload(authenticated: boolean) {
  return JSON.stringify({
    state: {
      authenticated,
      user: authenticated ? simulatedProfile : null,
    },
    version: 2,
  });
}

async function seedBrowserState(
  page: Page,
  options: {
    playlists?: unknown[];
    queue?: unknown[];
    authenticated?: boolean;
    enableAutoMatch?: boolean;
    enableProxyFallback?: boolean;
    sourceConfigs?: unknown[];
  } = {}
) {
  await page.addInitScript(
    ({ musicState, sessionState }) => {
      localStorage.clear();
      localStorage.setItem("oh_music_store", musicState);
      localStorage.setItem("oh_netease_store", sessionState);
    },
    {
      musicState: musicStatePayload(options.playlists, options.queue, options),
      sessionState: sessionStatePayload(Boolean(options.authenticated)),
    }
  );
}

async function seedIndexedDbMusicState(
  page: Page,
  options: Parameters<typeof seedBrowserState>[1] = {}
) {
  const value = musicStatePayload(options.playlists, options.queue, options);
  await page.evaluate(
    ({ key, value: serialized }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("keyval-store");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("keyval", "readwrite");
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.objectStore("keyval").put(serialized, key);
        };
      }),
    { key: "oh_music_store", value }
  );
}

async function mockSameOriginApi(
  page: Page,
  { session = "anonymous", onLogout, autoMatchFixture }: MockApiOptions = {}
) {
  await page.route("**/e2e-media/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: wavSilence,
      headers: { "Cache-Control": "no-store" },
    });
  });

  await page.route("**/music-api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname === "/music-api/netease/session/me") {
      if (session === "expired") {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "Session expired" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          session === "authenticated"
            ? { authenticated: true, profile: simulatedProfile }
            : { authenticated: false }
        ),
      });
      return;
    }

    if (pathname === "/music-api/netease/logout") {
      onLogout?.();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated: false }),
      });
      return;
    }

    if (pathname === "/music-api/audio" && autoMatchFixture) {
      const url = new URL(request.url());
      const id = url.searchParams.get("id") ?? "";
      autoMatchFixture.onSecondaryUrlRequest?.(id);
      await route.fulfill({
        status:
          url.searchParams.get("source") === "joox" && id === "correct-studio"
            ? 200
            : 404,
        contentType: "audio/wav",
        body: wavSilence,
        headers: { "Cache-Control": "no-store" },
      });
      return;
    }

    let body: unknown = { data: {} };
    if (pathname === "/music-api/netease/search") {
      body = {
        data: {
          code: 200,
          result: {
            songs: [
              {
                id: 7001,
                name: "E2E 搜索结果",
                ar: [{ id: 81, name: "测试歌手" }],
                al: { id: 91, name: "测试专辑", picUrl: "" },
                fee: 0,
              },
            ],
            songCount: 1,
            hasMore: false,
          },
        },
      };
    } else if (pathname === "/music-api/netease/search/suggest") {
      body = { data: { result: {} } };
    } else if (pathname === "/music-api/netease/playlists") {
      body = { data: { playlists: [] } };
    } else if (pathname === "/music-api/netease/toplist") {
      body = { data: { list: [] } };
    } else if (pathname === "/music-api/netease/recommend") {
      body = { result: [] };
    } else if (pathname === "/music-api/netease/user-playlists") {
      body = { code: 200, more: false, playlist: [] };
    } else if (
      pathname === "/music-api/netease/album/sublist" ||
      pathname === "/music-api/netease/artist/sublist"
    ) {
      body = { data: { data: [] } };
    } else if (pathname === "/music-api/netease/song-url") {
      if (autoMatchFixture) {
        let requestBody: { id?: string | number } = {};
        try {
          requestBody = request.postDataJSON() as {
            id?: string | number;
          };
        } catch {
          // A malformed fixture request is recorded as an empty identifier and
          // will fail the exact request assertions below.
        }
        autoMatchFixture.onPrimaryUrlRequest?.(String(requestBody.id ?? ""));
        body = {
          data: {
            data: [
              {
                url: "/e2e-media/primary-fail.wav",
                br: 192000,
                size: 44,
              },
            ],
          },
        };
      } else {
        body = { data: { data: [] } };
      }
    } else if (pathname === "/music-api/netease/song-detail") {
      body = { id: 7001, name: "E2E 搜索结果", ar: [], al: {} };
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.route(/\/music-api(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const requestType = url.searchParams.get("types");
    let body: unknown = [];

    if (autoMatchFixture && requestType === "search") {
      autoMatchFixture.onSearch?.();
      body = [
        {
          id: "wrong-live-duet",
          name: "愛錯 (feat. 單依純) (Live)",
          artist: ["王力宏", "單依純"],
          album: "愛錯 (Live)",
          pic_id: "",
          url_id: "wrong-live-duet",
          lyric_id: "wrong-live-duet",
          duration: 247,
        },
        {
          id: "correct-studio",
          name: "爱错",
          artist: ["王力宏"],
          album: "心中的日月",
          pic_id: "",
          url_id: "correct-studio",
          lyric_id: "correct-studio",
          duration: 246,
        },
      ];
    } else if (autoMatchFixture && requestType === "url") {
      const id = url.searchParams.get("id") ?? "";
      autoMatchFixture.onSecondaryUrlRequest?.(id);
      body = {
        url: id === "correct-studio" ? "/e2e-media/secondary-ok.wav" : null,
      };
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

async function openCorePage(
  page: Page,
  path = "/search",
  apiOptions?: MockApiOptions,
  browserState?: Parameters<typeof seedBrowserState>[1]
) {
  await seedBrowserState(page, browserState);
  await mockSameOriginApi(page, apiOptions);
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    root:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  }));
  expect(
    overflow.body,
    `body overflowed by ${overflow.body}px`
  ).toBeLessThanOrEqual(1);
  expect(
    overflow.root,
    `root overflowed by ${overflow.root}px`
  ).toBeLessThanOrEqual(1);
}

async function expectTouchTargets(page: Page) {
  const undersized = await page
    .locator(TOUCH_TARGET_SELECTOR)
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        let ancestor = element.parentElement;
        let hiddenByAncestor = false;
        while (ancestor) {
          const ancestorStyle = getComputedStyle(ancestor);
          if (
            ancestorStyle.display === "none" ||
            ancestorStyle.visibility === "hidden" ||
            Number(ancestorStyle.opacity) === 0
          ) {
            hiddenByAncestor = true;
            break;
          }
          ancestor = ancestor.parentElement;
        }
        const hidden =
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0 ||
          style.pointerEvents === "none" ||
          rect.width === 0 ||
          rect.height === 0 ||
          hiddenByAncestor ||
          element.closest("[hidden], [aria-hidden=true]") !== null;
        if (hidden || (rect.width >= 44 && rect.height >= 44)) return [];
        const label =
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          element.textContent?.trim().slice(0, 30) ||
          "unnamed";
        return [
          `${element.tagName.toLowerCase()}[${label}] ${Math.round(rect.width)}x${Math.round(rect.height)}`,
        ];
      })
    );
  expect(
    undersized,
    `undersized touch targets:\n${undersized.join("\n")}`
  ).toEqual([]);
}

async function expectNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const violations = results.violations.filter(
    (violation) =>
      violation.impact === "critical" || violation.impact === "serious"
  );
  expect(
    violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      nodes: nodes.map((node) => ({
        target: node.target,
        html: node.html,
        failureSummary: node.failureSummary,
      })),
    }))
  ).toEqual([]);
}

for (const corePage of [
  { path: "/search", readyText: "发现" },
  { path: "/mine", readyText: "我的歌单" },
  { path: "/settings", readyText: "系统设置" },
]) {
  test(`${corePage.path} passes mobile a11y, overflow, and touch-target checks`, async ({
    page,
  }) => {
    await openCorePage(page, corePage.path);
    await expect(
      page.getByText(corePage.readyText, { exact: true }).first()
    ).toBeVisible();
    if (corePage.path === "/search") {
      await expect(
        page.getByPlaceholder("搜索音乐、歌手或专辑...")
      ).toBeVisible();
      await expect(
        page.getByText("网易云(官方)", { exact: true }).first()
      ).toBeVisible();
    }
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.getAnimations().filter((animation) => {
              const iterations = animation.effect?.getTiming().iterations;
              return (
                animation.playState === "running" && iterations !== Infinity
              );
            }).length
        )
      )
      .toBe(0);
    await expectNoHorizontalOverflow(page);
    await expectTouchTargets(page);
    await expectNoSeriousA11yViolations(page);
  });
}

test("search uses a deterministic same-origin NetEase fixture", async ({
  page,
}) => {
  await openCorePage(page);
  const input = page.getByPlaceholder("搜索音乐、歌手或专辑...");
  await expect(
    page.getByText("网易云(官方)", { exact: true }).first()
  ).toBeVisible();
  await input.fill("测试歌曲");
  await input.press("Enter");
  await expect(page.getByText("E2E 搜索结果", { exact: true })).toBeVisible();
  await expect(
    page.getByText("测试歌手 • 测试专辑", { exact: true }).first()
  ).toBeVisible();
});

test("a slow 362-track NetEase playlist loads on mobile", async ({
  page,
}, testInfo) => {
  onlyBaseline(testInfo);
  await seedBrowserState(page, { authenticated: true });
  await mockSameOriginApi(page, { session: "authenticated" });
  await page.route("**/music-api/netease/playlist", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 12_500));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: 366135532,
        name: "我喜欢的音乐",
        coverImgUrl: "",
        description: "",
        creator: simulatedProfile,
        trackCount: 362,
        playCount: 1,
        tracks: Array.from({ length: 362 }, (_, index) => ({
          id: 80_000 + index,
          name: `长歌单曲目 ${index + 1}`,
          ar: [{ id: 81, name: "测试歌手" }],
          al: { id: 91, name: "测试专辑", picUrl: "" },
          fee: 0,
          dt: 180_000,
        })),
      }),
    });
  });

  await page.goto("/netease-playlist/366135532", {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByRole("heading", { name: "我喜欢的音乐", exact: true }).first()
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("362 首", { exact: true })).toBeVisible();
  await expect(page.getByText("长歌单曲目 1", { exact: true })).toBeVisible();
  await expect(page.getByText("加载失败", { exact: true })).toHaveCount(0);
});

test("keyboard focus reaches the primary navigation", async ({ page }) => {
  await openCorePage(page);
  for (let index = 0; index < 16; index += 1) {
    await page.keyboard.press("Tab");
    const activeLabel = await page.evaluate(() => {
      const active = document.activeElement;
      return (
        active?.getAttribute("aria-label") || active?.textContent?.trim() || ""
      );
    });
    if (["发现", "喜欢", "我的"].includes(activeLabel)) return;
  }
  throw new Error(
    "Primary navigation was not keyboard reachable within 16 tabs"
  );
});

test("200% browser zoom keeps primary controls usable", async ({
  context,
  page,
}, testInfo) => {
  onlyBaseline(testInfo);
  await openCorePage(page);

  const session = await context.newCDPSession(page);
  await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
  try {
    await expect
      .poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1))
      .toBeGreaterThanOrEqual(1.9);
    await expect(
      page.getByPlaceholder("搜索音乐、歌手或专辑...")
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "发现" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  } finally {
    await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  }
});

test("simulated server session safely restores the browser account view", async ({
  page,
}, testInfo) => {
  onlyBaseline(testInfo);
  await openCorePage(
    page,
    "/settings",
    { session: "authenticated" },
    { authenticated: true }
  );
  await expect(page.getByText("模拟会话用户", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "打开网易云账号" })
  ).toBeVisible();
});

test("a simulated 401 expires persisted UI state without exposing credentials", async ({
  page,
}, testInfo) => {
  onlyBaseline(testInfo);
  allowConsoleErrors(
    page,
    /^Failed to load resource: the server responded with a status of 401 \(Unauthorized\)$/
  );
  await openCorePage(
    page,
    "/settings",
    { session: "expired" },
    { authenticated: true }
  );
  await expect(
    page.getByRole("button", { name: "登录", exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("登录后可同步歌单", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("模拟会话用户", { exact: true })).toHaveCount(0);

  const storage = await page.evaluate(() =>
    localStorage.getItem("oh_netease_store")
  );
  expect(storage).not.toContain("cookie");
  expect(storage).not.toContain("MUSIC_U");
});

test("simulated logout calls the same-origin endpoint and clears the UI", async ({
  page,
}, testInfo) => {
  onlyBaseline(testInfo);
  let logoutCalls = 0;
  await openCorePage(
    page,
    "/settings",
    {
      session: "authenticated",
      onLogout: () => {
        logoutCalls += 1;
      },
    },
    { authenticated: true }
  );
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "打开网易云账号" }).click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(
    page.getByRole("button", { name: "登录", exact: true })
  ).toBeVisible();
  expect(logoutCalls).toBe(1);
});

async function installMediaHarness(
  page: Page,
  mode: "success" | "failure" | "selective-fallback"
) {
  await page.addInitScript((mediaMode) => {
    const paused = new WeakMap<HTMLMediaElement, boolean>();
    const currentTimes = new WeakMap<HTMLMediaElement, number>();
    const attempts: string[] = [];
    const playedUrls: string[] = [];
    Object.defineProperty(window, "__e2eAudioAttempts", {
      configurable: true,
      get: () => [...attempts],
    });
    Object.defineProperty(window, "__e2ePlayedUrls", {
      configurable: true,
      get: () => [...playedUrls],
    });
    Object.defineProperty(HTMLMediaElement.prototype, "paused", {
      configurable: true,
      get() {
        return paused.get(this) ?? true;
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "duration", {
      configurable: true,
      get() {
        return 180;
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      configurable: true,
      get() {
        return currentTimes.get(this) ?? 0;
      },
      set(value: number) {
        currentTimes.set(this, Number.isFinite(value) ? value : 0);
      },
    });
    HTMLMediaElement.prototype.load = function () {
      // `currentSrc` may still describe the replaced resource until the media
      // selection algorithm catches up. The harness must exercise the URL the
      // application just assigned, not misclassify it as the previous source.
      attempts.push(
        this.getAttribute("src") || this.src || this.currentSrc || "empty-src"
      );
      queueMicrotask(() => {
        if (mediaMode === "failure") {
          this.dispatchEvent(new Event("error"));
        } else {
          this.dispatchEvent(new Event("loadedmetadata"));
          this.dispatchEvent(new Event("canplay"));
        }
      });
    };
    HTMLMediaElement.prototype.play = async function () {
      const source =
        this.getAttribute("src") || this.src || this.currentSrc || "empty-src";
      if (
        mediaMode === "failure" ||
        (mediaMode === "selective-fallback" && source.includes("primary-fail"))
      ) {
        throw new DOMException("Simulated media failure", "NotSupportedError");
      }
      playedUrls.push(source);
      paused.set(this, false);
      this.dispatchEvent(new Event("play"));
      this.dispatchEvent(new Event("playing"));
    };
    HTMLMediaElement.prototype.pause = function () {
      paused.set(this, true);
      this.dispatchEvent(new Event("pause"));
    };
  }, mode);
}

function fixturePlaylistState(tracks: readonly unknown[] = fixtureTracks) {
  return {
    playlists: [
      {
        id: "e2e-playlist",
        name: "E2E 测试歌单",
        tracks,
        createdAt: 1,
        update_time: 1,
        is_deleted: false,
      },
    ],
  };
}

test("playing a playlist adds every fixture track to the queue", async ({
  page,
}, testInfo) => {
  onlyBaseline(testInfo);
  await installMediaHarness(page, "success");
  await openCorePage(
    page,
    "/playlist/e2e-playlist",
    undefined,
    fixturePlaylistState()
  );
  await expect(
    page.getByText("E2E 测试歌单", { exact: true }).first()
  ).toBeVisible();
  await page.getByRole("button", { name: "播放全部" }).click();
  await expect(page.getByRole("button", { name: "播放列表" })).toBeVisible();
  await page.getByRole("button", { name: "播放列表" }).click();
  await expect(
    page.getByRole("button", { name: "播放 测试曲目一", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "播放 测试曲目二", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "播放列表 2", exact: true })
  ).toBeVisible();
});

test("primary source failure auto-matches the correct secondary recording and plays it", async ({
  page,
}, testInfo) => {
  onlyBaseline(testInfo);
  allowConsoleErrors(
    page,
    /^\[useAudioTrackLoader\] Audio load failed: Simulated media failure\b/
  );
  await installMediaHarness(page, "selective-fallback");
  const primaryUrlRequests: string[] = [];
  const secondaryUrlRequests: string[] = [];
  let searchCalls = 0;
  const targetTrack = {
    id: "primary-ai-cuo",
    name: "爱错",
    artist: ["王力宏"],
    album: "心中的日月",
    pic_id: "",
    url_id: "primary-ai-cuo",
    lyric_id: "primary-ai-cuo",
    source: "_netease",
    duration: 246,
    update_time: 1,
    is_deleted: false,
  };

  await openCorePage(
    page,
    "/playlist/e2e-playlist",
    {
      autoMatchFixture: {
        onPrimaryUrlRequest: (id) => primaryUrlRequests.push(id),
        onSearch: () => {
          searchCalls += 1;
        },
        onSecondaryUrlRequest: (id) => secondaryUrlRequests.push(id),
      },
    },
    {
      ...fixturePlaylistState([targetTrack]),
      enableAutoMatch: true,
      enableProxyFallback: false,
      sourceConfigs: [
        { source: "_netease", enabled: true, visible: true },
        { source: "joox", enabled: true, visible: true },
      ],
    }
  );
  await page.getByRole("button", { name: "播放全部" }).click();

  await expect(page.getByRole("button", { name: "暂停" })).toBeVisible();
  await expect.poll(() => secondaryUrlRequests).toEqual(["correct-studio"]);
  const successfulPlaybackUrls = await page.evaluate(
    () =>
      (window as unknown as { __e2ePlayedUrls?: string[] }).__e2ePlayedUrls ??
      []
  );
  expect(primaryUrlRequests).toEqual(["primary-ai-cuo"]);
  expect(searchCalls).toBe(1);
  expect(secondaryUrlRequests).not.toContain("wrong-live-duet");
  expect(successfulPlaybackUrls).toHaveLength(1);
  const successfulPlaybackUrl = new URL(successfulPlaybackUrls[0], page.url());
  expect(successfulPlaybackUrl.pathname).toBe("/music-api/audio");
  expect(successfulPlaybackUrl.searchParams.get("source")).toBe("joox");
  expect(successfulPlaybackUrl.searchParams.get("id")).toBe("correct-studio");
  expect(successfulPlaybackUrl.href).not.toContain("wrong-live-duet");
  const matchedTrack = page.getByRole("button", {
    name: "播放：爱错",
    exact: true,
  });
  await expect(matchedTrack).toContainText("Joox");
  await expect(matchedTrack).toContainText("王力宏 • 心中的日月");
  await expect(matchedTrack).not.toContainText("單依純");

  await page.getByRole("button", { name: "播放列表" }).click();
  const queueDialog = page.getByRole("dialog", { name: "播放列表" });
  await expect(
    queueDialog.getByRole("button", { name: /播放列表\s*1/ })
  ).toBeVisible();
  await expect(
    queueDialog.getByRole("button", { name: "播放 爱错" })
  ).toHaveAttribute("aria-current", "true");
});

test("repeated playback failure stops after the bounded fallback budget", async ({
  page,
}, testInfo) => {
  onlyBaseline(testInfo);
  allowConsoleErrors(page, /Simulated media failure|Audio load failed/i);
  await installMediaHarness(page, "failure");
  const failingTracks = Array.from({ length: 5 }, (_, index) => ({
    ...fixtureTracks[index % fixtureTracks.length],
    id: `failing-track-${index + 1}`,
    name: `失败曲目 ${index + 1}`,
    url_id: `/e2e-media/failing-${index + 1}.wav`,
  }));
  await openCorePage(
    page,
    "/playlist/e2e-playlist",
    undefined,
    fixturePlaylistState(failingTracks)
  );
  await page.getByRole("button", { name: "播放全部" }).click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            (window as unknown as { __e2eAudioAttempts?: string[] })
              .__e2eAudioAttempts ?? []
          ).length
      )
    )
    .toBeGreaterThanOrEqual(3);
  const firstCount = await page.evaluate(
    () =>
      (
        (window as unknown as { __e2eAudioAttempts?: string[] })
          .__e2eAudioAttempts ?? []
      ).length
  );
  await page.waitForTimeout(750);
  const stableCount = await page.evaluate(
    () =>
      (
        (window as unknown as { __e2eAudioAttempts?: string[] })
          .__e2eAudioAttempts ?? []
      ).length
  );
  expect(stableCount).toBe(firstCount);
  expect(stableCount).toBeLessThanOrEqual(6);
  await expect(
    page.getByText("播放失败，已自动切到下一首").last()
  ).toBeVisible();
});

async function ensureControlledServiceWorker(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const registration =
            await navigator.serviceWorker.getRegistration("/");
          return registration?.active?.state ?? "missing";
        }),
      {
        message: "The app did not install an active root service worker",
        timeout: 15_000,
      }
    )
    .toBe("activated");
  if (
    !(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
  ) {
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  expect(
    await page.evaluate(() => Boolean(navigator.serviceWorker.controller))
  ).toBe(true);
}

test("a waiting service-worker update never interrupts active playback", async ({
  page,
}, testInfo) => {
  onlyBaseline(testInfo);
  await installMediaHarness(page, "success");
  await seedBrowserState(page, fixturePlaylistState());
  await mockSameOriginApi(page);
  await page.goto("/playlist/e2e-playlist", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByText("E2E 测试歌单", { exact: true }).first()
  ).toBeVisible();
  // The product's authoritative music store lives in IndexedDB. Own that
  // fixture explicitly before the first controller reload instead of relying
  // on the one-time localStorage migration to finish during navigation.
  await seedIndexedDbMusicState(page, fixturePlaylistState());
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const registration =
            await navigator.serviceWorker.getRegistration("/");
          return registration?.active?.state ?? "missing";
        }),
      {
        message: "The first-install worker did not activate",
        timeout: 15_000,
      }
    )
    .toBe("activated");
  expect(
    await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    "A first installation must not claim the already-open page"
  ).toBe(false);
  await ensureControlledServiceWorker(page);
  await expect(
    page.getByText("E2E 测试歌单", { exact: true }).first()
  ).toBeVisible();
  await page.getByRole("button", { name: "播放全部" }).click();
  await expect(page.getByRole("button", { name: "暂停" })).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "打开正在播放：测试曲目一",
      exact: true,
    })
  ).toBeVisible();

  const workerFilePath = join(process.cwd(), "dist", "sw.js");
  const originalWorker = await readFile(workerFilePath, "utf8");
  const deploymentRevision = `playwright-deploy-${Date.now()}`;
  // A real deployment changes the generated worker bytes through its precache
  // revision. This inert build marker models that byte change without adding
  // install/activate/message behavior: every lifecycle transition under test
  // still comes exclusively from the production worker above.
  const updatedWorker = `${originalWorker}\n/* ${deploymentRevision} */\n`;
  replacedWorkerFiles.set(workerFilePath, originalWorker);
  await writeFile(workerFilePath, updatedWorker, "utf8");
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    if (!registration) throw new Error("The root service worker is missing");
    await registration.update();
  });
  const prompt = page.getByRole("region", { name: "播放器更新" });
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration("/");
        return registration?.waiting?.scriptURL ?? "missing";
      })
    )
    .toContain("/sw.js");
  await writeFile(workerFilePath, originalWorker, "utf8");
  replacedWorkerFiles.delete(workerFilePath);
  await expect(prompt.getByText("请先暂停音乐，再刷新到新版本")).toBeVisible();
  await expect(
    prompt.getByRole("button", { name: "更新", exact: true })
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "暂停" })).toBeVisible();

  // Once the listener has proved it will not interrupt playback, pause and
  // exercise the complete user-approved activation/reload path. The marker is
  // session-scoped so it survives the reload but cannot fake persisted player
  // state.
  await page.evaluate(() => {
    sessionStorage.removeItem("e2e-sw-controller-changed");
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => sessionStorage.setItem("e2e-sw-controller-changed", "yes"),
      { once: true }
    );
    const audio = document.querySelector("audio");
    if (!audio) throw new Error("The global audio element is missing");
    audio.currentTime = 37;
    audio.dispatchEvent(new Event("durationchange"));
  });
  // The production timeupdate handler is throttled to one write per second.
  // Wait a complete window, then prove the exact persisted value rather than
  // relying on an arbitrary delay before the user approves the update.
  await page.waitForTimeout(1_100);
  await page.evaluate(() => {
    document.querySelector("audio")?.dispatchEvent(new Event("timeupdate"));
  });
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            new Promise<number>((resolve, reject) => {
              const request = indexedDB.open("keyval-store");
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains("keyval")) {
                  database.close();
                  resolve(-1);
                  return;
                }
                const transaction = database.transaction("keyval", "readonly");
                const valueRequest = transaction
                  .objectStore("keyval")
                  .get("oh_music_store");
                valueRequest.onerror = () => reject(valueRequest.error);
                valueRequest.onsuccess = () => {
                  database.close();
                  try {
                    const value = JSON.parse(String(valueRequest.result));
                    resolve(Number(value?.state?.currentAudioTime ?? -1));
                  } catch {
                    resolve(-1);
                  }
                };
              };
            })
        ),
      {
        message: "The observed playback position was not persisted",
        timeout: 5_000,
      }
    )
    .toBe(37);
  await page.getByRole("button", { name: "暂停" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => document.querySelector("audio")?.paused ?? true)
    )
    .toBe(true);
  const updateButton = prompt.getByRole("button", {
    name: "更新",
    exact: true,
  });
  await expect(updateButton).toBeEnabled();
  await expect(
    page.getByRole("button", {
      name: "打开正在播放：测试曲目一",
      exact: true,
    })
  ).toBeVisible();

  const reloaded = page.waitForEvent("framenavigated", (frame) => {
    return (
      frame === page.mainFrame() &&
      new URL(frame.url()).pathname === "/playlist/e2e-playlist"
    );
  });
  await updateButton.click();
  await reloaded;
  await page.waitForLoadState("domcontentloaded");

  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("e2e-sw-controller-changed")
    )
  ).toBe("yes");
  await expect
    .poll(() =>
      page.evaluate(
        () => navigator.serviceWorker.controller?.scriptURL ?? "missing"
      )
    )
    .toContain("/sw.js");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration("/");
        return {
          active: registration?.active?.state ?? "missing",
          waiting: registration?.waiting?.state ?? "none",
        };
      })
    )
    .toEqual({ active: "activated", waiting: "none" });

  // Queue and current-track identity must survive the controller change and
  // reload. Playback intentionally remains paused until a new user gesture.
  await expect(
    page.getByText("E2E 测试歌单", { exact: true }).first()
  ).toBeVisible();
  await page
    .getByRole("button", { name: "打开正在播放：测试曲目一", exact: true })
    .click();
  const restoredProgress = page.getByRole("slider", { name: "播放进度" });
  await expect(restoredProgress).toHaveAttribute("aria-valuemax", "180");
  await expect(restoredProgress).toHaveAttribute("aria-valuenow", "37");
  await page.getByRole("button", { name: "收起全屏播放器" }).click();
  await expect(
    page.getByRole("button", { name: "播放", exact: true })
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.querySelector("audio")?.paused ?? true)
  ).toBe(true);
  await expect(page.getByRole("button", { name: "播放列表" })).toBeVisible();
  await page.getByRole("button", { name: "播放列表" }).click();
  const queueDialog = page.getByRole("dialog", { name: "播放列表" });
  await expect(
    queueDialog.getByRole("button", { name: "播放列表 2", exact: true })
  ).toBeVisible();
  await expect(
    queueDialog.getByRole("button", { name: "播放 测试曲目一", exact: true })
  ).toHaveAttribute("aria-current", "true");
});

test("a previously visited deep route reloads from the offline app shell", async ({
  context,
  page,
}, testInfo) => {
  onlyBaseline(testInfo);
  allowRequestFailures(page, /.*/);
  await openCorePage(page, "/settings");
  await expect(page.getByText("系统设置", { exact: true })).toBeVisible();
  await ensureControlledServiceWorker(page);

  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("系统设置", { exact: true })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
