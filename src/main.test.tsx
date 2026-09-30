import { beforeEach, describe, expect, it, vi } from "vitest";

const bootstrapMocks = vi.hoisted(() => {
  let resolveCleanup: (() => void) | undefined;
  return {
    cleanup: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        })
    ),
    purgeLegacyAlbumRestore: vi.fn(),
    render: vi.fn(),
    resolveCleanup: () => resolveCleanup?.(),
  };
});

vi.mock("react-dom/client", () => ({
  createRoot: vi.fn(() => ({ render: bootstrapMocks.render })),
}));
vi.mock("./lib/legacy-offline-cleanup", () => ({
  clearRetiredSyncArtifacts: bootstrapMocks.cleanup,
}));
vi.mock("./lib/navigation/netease-detail-navigation", () => ({
  purgeLegacyAlbumSheetRestoreSession: bootstrapMocks.purgeLegacyAlbumRestore,
}));
vi.mock("./lib/logger", () => ({ initializeLogger: vi.fn() }));
vi.mock("./Layout", () => ({ default: () => null }));
vi.mock("./App", () => ({ default: () => null }));
vi.mock("./components/ErrorBoundary", () => ({
  ErrorBoundary: () => null,
}));

describe("application bootstrap", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
  });

  it("starts retired-capability cleanup immediately and awaits it before rendering", async () => {
    await import("./main");

    expect(bootstrapMocks.purgeLegacyAlbumRestore).toHaveBeenCalledTimes(1);
    expect(bootstrapMocks.cleanup).toHaveBeenCalledTimes(1);
    expect(bootstrapMocks.render).not.toHaveBeenCalled();

    bootstrapMocks.resolveCleanup();
    await vi.waitFor(() => {
      expect(bootstrapMocks.render).toHaveBeenCalledTimes(1);
    });
  });
});
