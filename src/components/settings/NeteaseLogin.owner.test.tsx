import { act, forwardRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NeteaseLogin } from "./NeteaseLogin";
import { useNeteaseStore } from "@/store/netease-store";
import { useMarketSession } from "@/store/session/market-session";

const api = vi.hoisted(() => ({
  checkQrStatus: vi.fn(),
  getNeteaseSession: vi.fn(),
  getQrKey: vi.fn(),
  loginCellphone: vi.fn(),
  logoutNeteaseSession: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/netease/netease-api", () => api);
vi.mock("react-hot-toast", () => ({ default: toast }));
vi.mock("@/lib/netease/qr-download", () => ({
  saveQrCanvasAsPng: vi.fn().mockResolvedValue(true),
}));
vi.mock("qrcode.react", () => ({
  QRCodeCanvas: forwardRef<HTMLCanvasElement, { value: string; size?: number }>(
    ({ value, size }, ref) => (
      <canvas ref={ref} data-qr-value={value} data-qr-size={size} />
    )
  ),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    children?: ReactNode;
    variant?: string;
    size?: string;
  }) => <button {...props}>{children}</button>,
}));
vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  AvatarImage: ({ src }: { src?: string }) => <img alt="" src={src} />,
  AvatarFallback: ({ children }: { children?: ReactNode }) => (
    <span>{children}</span>
  ),
}));
vi.mock("./SettingItem", () => ({
  SettingItem: ({ title, action }: { title: string; action?: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {action}
    </section>
  ),
}));
vi.mock("@/components/ui/drawer", () => ({
  Drawer: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children?: ReactNode;
  }) =>
    open ? (
      <div data-testid="drawer">
        <button
          type="button"
          aria-label="关闭抽屉"
          onClick={() => onOpenChange(false)}
        />
        {children}
      </div>
    ) : null,
  DrawerContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DrawerHeader: ({ children }: { children?: ReactNode }) => (
    <header>{children}</header>
  ),
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h3>{children}</h3>,
  DrawerDescription: ({ children }: { children?: ReactNode }) => (
    <p>{children}</p>
  ),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const oldProfile = {
  userId: 1,
  nickname: "Old owner",
  avatarUrl: "https://example.com/old.jpg",
};
const newProfile = {
  userId: 2,
  nickname: "New owner",
  avatarUrl: "https://example.com/new.jpg",
};

describe("NeteaseLogin account operation ownership", () => {
  let root: Root;
  let container: HTMLDivElement;

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  const clickButton = (name: string) => {
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(name)
    );
    expect(button).toBeDefined();
    act(() => {
      button!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      button!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      button!.click();
    });
  };

  const openQrLogin = async () => {
    const qrCallsBeforeOpen = api.getQrKey.mock.calls.length;
    clickButton("登录");
    await flush();
    expect(api.getQrKey).toHaveBeenCalledTimes(qrCallsBeforeOpen);
    clickButton("扫码");
    await flush();
    await flush();
    expect(api.getQrKey).toHaveBeenCalledTimes(qrCallsBeforeOpen + 1);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useNeteaseStore.getState().clearSession();
    useMarketSession.getState().clearSession();
    api.getNeteaseSession.mockImplementation(() => new Promise(() => {}));
    api.checkQrStatus.mockImplementation(() => new Promise(() => {}));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<NeteaseLogin />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders a smaller QR source and exposes a long-pressable image", async () => {
    api.getQrKey.mockResolvedValue("qr-key");
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,qr"
    );

    await openQrLogin();
    await flush();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    });

    expect(container.querySelector("canvas")?.dataset.qrSize).toBe("256");
    expect(
      container.querySelector('img[alt*="长按保存到相册"]')
    ).not.toBeNull();
  });

  it("aborts a closed QR owner and ignores its late key after reopen", async () => {
    const oldKey = deferred<string>();
    const newKey = deferred<string>();
    api.getQrKey
      .mockImplementationOnce(() => oldKey.promise)
      .mockImplementationOnce(() => newKey.promise);

    await openQrLogin();
    const oldSignal = api.getQrKey.mock.calls[0][0] as AbortSignal;
    expect(oldSignal.aborted).toBe(false);

    const close = container.querySelector<HTMLButtonElement>(
      'button[aria-label="关闭抽屉"]'
    );
    expect(close).not.toBeNull();
    act(() => close!.click());
    expect(oldSignal.aborted).toBe(true);

    await openQrLogin();
    const newSignal = api.getQrKey.mock.calls[1][0] as AbortSignal;
    expect(newSignal.aborted).toBe(false);

    await act(async () => newKey.resolve("new/key"));
    expect(
      container.querySelector("canvas")?.getAttribute("data-qr-value")
    ).toBe("https://music.163.com/login?codekey=new%2Fkey");

    await act(async () => oldKey.resolve("stale-key"));
    expect(
      container.querySelector("canvas")?.getAttribute("data-qr-value")
    ).toBe("https://music.163.com/login?codekey=new%2Fkey");
  });

  it("ignores a late 803 check from a QR owner closed before reopen", async () => {
    const staleStatus = deferred<{
      code: number;
      message: string;
      profile?: typeof oldProfile;
    }>();
    api.getQrKey
      .mockResolvedValueOnce("old-key")
      .mockResolvedValueOnce("new-key");
    api.checkQrStatus
      .mockReturnValueOnce(staleStatus.promise)
      .mockImplementationOnce(() => new Promise(() => {}));

    await openQrLogin();
    const staleSignal = api.checkQrStatus.mock.calls[0][1] as AbortSignal;
    expect(staleSignal.aborted).toBe(false);

    const close = container.querySelector<HTMLButtonElement>(
      'button[aria-label="关闭抽屉"]'
    );
    act(() => close!.click());
    await openQrLogin();
    expect(staleSignal.aborted).toBe(true);
    expect(api.checkQrStatus).toHaveBeenCalledTimes(2);

    await act(async () =>
      staleStatus.resolve({ code: 803, message: "ok", profile: oldProfile })
    );
    expect(useNeteaseStore.getState().authenticated).toBe(false);
    expect(
      container.querySelector("canvas")?.getAttribute("data-qr-value")
    ).toBe("https://music.163.com/login?codekey=new-key");
  });

  it("does not let a late mount restore replace a completed QR login", async () => {
    const restore = deferred<typeof oldProfile | null>();
    const qrStatus = deferred<{
      code: number;
      message: string;
      profile?: typeof newProfile;
    }>();
    api.getNeteaseSession.mockReturnValueOnce(restore.promise);
    api.getQrKey.mockResolvedValueOnce("new-key");
    api.checkQrStatus.mockReturnValueOnce(qrStatus.promise);

    // Remount so the deferred restore belongs to this test's active owner.
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<NeteaseLogin />));
    await flush();
    const restoreSignal = api.getNeteaseSession.mock.calls.at(
      -1
    )?.[0] as AbortSignal;

    await openQrLogin();
    expect(restoreSignal.aborted).toBe(true);
    await act(async () =>
      qrStatus.resolve({ code: 803, message: "ok", profile: newProfile })
    );
    await flush();
    expect(useNeteaseStore.getState().user).toEqual(newProfile);

    await act(async () => restore.resolve(oldProfile));
    expect(useNeteaseStore.getState().user).toEqual(newProfile);
  });

  it("aborts mount restore when logout takes ownership and ignores its late result", async () => {
    const restore = deferred<typeof newProfile | null>();
    const logout = deferred<void>();
    api.getNeteaseSession.mockReturnValueOnce(restore.promise);
    api.logoutNeteaseSession.mockReturnValueOnce(logout.promise);
    useNeteaseStore.getState().setSession(oldProfile);

    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<NeteaseLogin />));
    await flush();
    const restoreSignal = api.getNeteaseSession.mock.calls.at(
      -1
    )?.[0] as AbortSignal;

    const accountButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="打开网易云账号"]'
    );
    expect(accountButton).not.toBeNull();
    act(() => accountButton!.click());
    clickButton("退出登录");
    await flush();
    expect(restoreSignal.aborted).toBe(true);
    expect(api.logoutNeteaseSession.mock.calls.at(-1)?.[0]).toBeInstanceOf(
      AbortSignal
    );

    await act(async () => restore.resolve(newProfile));
    expect(useNeteaseStore.getState().user).toEqual(oldProfile);

    await act(async () => logout.resolve());
    expect(useNeteaseStore.getState().authenticated).toBe(false);
    expect(useNeteaseStore.getState().user).toBeNull();
  });

  it("does not let a superseded QR success take over an in-flight logout", async () => {
    const qrStatus = deferred<{
      code: number;
      message: string;
      profile?: typeof newProfile;
    }>();
    const logout = deferred<void>();
    api.getQrKey.mockResolvedValueOnce("pending-key");
    api.checkQrStatus.mockReturnValueOnce(qrStatus.promise);
    api.logoutNeteaseSession.mockReturnValueOnce(logout.promise);

    await openQrLogin();
    const qrSignal = api.checkQrStatus.mock.calls[0][1] as AbortSignal;
    act(() => useNeteaseStore.getState().setSession(oldProfile));
    await flush();
    const accountButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="打开网易云账号"]'
    );
    expect(accountButton).not.toBeNull();
    act(() => accountButton!.click());
    await flush();
    clickButton("退出登录");
    await flush();
    expect(qrSignal.aborted).toBe(true);

    await act(async () =>
      qrStatus.resolve({ code: 803, message: "ok", profile: newProfile })
    );
    expect(useNeteaseStore.getState().user).toEqual(oldProfile);

    await act(async () => logout.resolve());
    expect(useNeteaseStore.getState().user).toBeNull();
  });
});
