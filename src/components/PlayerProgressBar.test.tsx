import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PlayerProgressBar } from "./PlayerProgressBar";
import { useMusicStore } from "@/store/music-store";

vi.mock("idb-keyval", () => ({
  get: vi.fn(() => Promise.resolve(undefined)),
  set: vi.fn(() => Promise.resolve()),
  del: vi.fn(() => Promise.resolve()),
}));

describe("PlayerProgressBar", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    useMusicStore.setState({
      currentAudioTime: 125,
      duration: 300,
      seekTargetTime: 0,
    });
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container?.remove();
    document.body.innerHTML = "";
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
  });

  const render = (
    props?: Partial<React.ComponentProps<typeof PlayerProgressBar>>
  ) => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<PlayerProgressBar {...props} />);
    });
    return container;
  };

  const getTimeSpans = (el: HTMLElement) =>
    Array.from(el.querySelectorAll("span")).filter(
      (span) =>
        /^\d+:\d{2}$/.test(span.textContent ?? "") ||
        span.textContent?.includes("x")
    );

  it("renders current time and total duration", () => {
    const el = render();
    const text = el.textContent ?? "";
    expect(text).toContain("2:05");
    expect(text).toContain("5:00");
  });

  it("renders left time suffix when provided", () => {
    const el = render({
      leftTimeSuffix: <span data-testid="speed-suffix">x1.2</span>,
    });
    expect(el.querySelector('[data-testid="speed-suffix"]')?.textContent).toBe(
      "x1.2"
    );
  });

  it("calls onLeftTimeClick when current time is clicked", () => {
    const onLeftTimeClick = vi.fn();
    const el = render({ onLeftTimeClick });
    const spans = getTimeSpans(el);
    const leftSpan = spans.find((s) => s.textContent?.includes("2:05"));
    expect(leftSpan).toBeTruthy();
    act(() => {
      leftSpan!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onLeftTimeClick).toHaveBeenCalledTimes(1);
  });

  it("calls onRightTimeClick when duration is clicked", () => {
    const onRightTimeClick = vi.fn();
    const el = render({ onRightTimeClick });
    const spans = getTimeSpans(el);
    const rightSpan = spans.find((s) => s.textContent?.includes("5:00"));
    expect(rightSpan).toBeTruthy();
    act(() => {
      rightSpan!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRightTimeClick).toHaveBeenCalledTimes(1);
  });

  const dispatchPointer = (
    target: Element,
    type: string,
    clientX: number,
    pointerId = 1
  ) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
    });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    target.dispatchEvent(event);
  };

  it("commits a captured pointer drag", () => {
    const el = render();
    const slider = el.querySelector<HTMLElement>('[role="slider"]')!;
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 100,
      top: 0,
      right: 100,
      bottom: 20,
      height: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    slider.setPointerCapture = vi.fn();
    slider.hasPointerCapture = vi.fn(() => true);
    slider.releasePointerCapture = vi.fn();

    act(() => {
      dispatchPointer(slider, "pointerdown", 20);
      dispatchPointer(slider, "pointermove", 80);
      dispatchPointer(slider, "pointerup", 80);
    });

    expect(useMusicStore.getState().seekTargetTime).toBe(240);
    expect(slider.setPointerCapture).toHaveBeenCalledWith(1);
    expect(slider.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it("cancels a pointer drag without seeking or leaving drag state stuck", () => {
    const el = render();
    const slider = el.querySelector<HTMLElement>('[role="slider"]')!;
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 100,
      top: 0,
      right: 100,
      bottom: 20,
      height: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    slider.setPointerCapture = vi.fn();
    slider.hasPointerCapture = vi.fn(() => true);
    slider.releasePointerCapture = vi.fn();

    act(() => {
      dispatchPointer(slider, "pointerdown", 20);
      dispatchPointer(slider, "pointermove", 80);
      dispatchPointer(slider, "pointercancel", 80);
    });

    expect(useMusicStore.getState().seekTargetTime).toBe(0);
    expect(el.textContent).toContain("2:05");
    expect(el.textContent).not.toContain("4:00");
  });

  it("does not start or commit a drag without a valid duration", () => {
    useMusicStore.setState({ duration: Number.NaN, seekTargetTime: 0 });
    const el = render();
    const slider = el.querySelector<HTMLElement>('[role="slider"]')!;
    slider.setPointerCapture = vi.fn();

    act(() => {
      dispatchPointer(slider, "pointerdown", 50);
      dispatchPointer(slider, "pointerup", 50);
    });

    expect(slider.setPointerCapture).not.toHaveBeenCalled();
    expect(useMusicStore.getState().seekTargetTime).toBe(0);
  });
});
