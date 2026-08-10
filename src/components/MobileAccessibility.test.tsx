import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "lucide-react";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Select, SelectTrigger, SelectValue } from "./ui/select";
import { Slider } from "./ui/slider";
import { Switch } from "./ui/switch";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { SettingItem } from "./settings/SettingItem";
import { AggregatedSourceSelect } from "./settings/AggregatedSourceSelect";

describe("mobile interaction accessibility", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe() {
          return undefined;
        }

        unobserve() {
          return undefined;
        }

        disconnect() {
          return undefined;
        }
      }
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("keeps default and icon buttons at least 44 CSS pixels", () => {
    act(() =>
      root.render(
        <>
          <Button>保存</Button>
          <Button size="icon" aria-label="设置">
            <Settings />
          </Button>
        </>
      )
    );

    for (const button of container.querySelectorAll("button")) {
      expect(button.className).toContain("min-h-11");
      expect(button.className).toContain("min-w-11");
    }
  });

  it("makes a clickable setting keyboard operable", () => {
    const onClick = vi.fn();
    act(() =>
      root.render(
        <SettingItem
          icon={Settings}
          title="测试设置"
          onClick={onClick}
          showChevron
        />
      )
    );

    const setting = container.querySelector<HTMLElement>('[role="button"]');
    expect(setting?.tabIndex).toBe(0);
    expect(setting).not.toHaveAttribute("aria-label");
    expect(setting?.textContent).toContain("测试设置");
    act(() =>
      setting?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      )
    );
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("gives form controls a 44px interaction box without enlarging visuals", () => {
    act(() =>
      root.render(
        <>
          <Switch aria-label="同步" />
          <Checkbox aria-label="选择" />
          <Slider aria-label="音量" defaultValue={[50]} />
          <Input aria-label="名称" />
          <Select defaultValue="standard">
            <SelectTrigger aria-label="音质">
              <SelectValue />
            </SelectTrigger>
          </Select>
        </>
      )
    );

    expect(container.querySelector('[role="switch"]')?.className).toContain(
      "size-11"
    );
    expect(container.querySelector('[role="checkbox"]')?.className).toContain(
      "size-11"
    );
    expect(container.querySelector('[role="slider"]')?.className).toContain(
      "size-11"
    );
    expect(container.querySelector('[role="slider"]')).toHaveAttribute(
      "aria-label",
      "音量"
    );
    expect(container.querySelector("input")?.className).toContain("min-h-11");
    expect(container.querySelector('[role="combobox"]')?.className).toContain(
      "min-h-11"
    );
  });

  it("removes collapsed setting content from focus and the accessibility tree", () => {
    const renderSetting = (isExpanded: boolean) => (
      <SettingItem
        icon={Settings}
        title="可展开设置"
        onClick={() => undefined}
        isExpanded={isExpanded}
        expandedContent={<button type="button">隐藏操作</button>}
      />
    );

    act(() => root.render(renderSetting(false)));
    const collapsed = container.querySelector('[aria-hidden="true"][inert]');
    expect(collapsed).not.toBeNull();

    act(() => root.render(renderSetting(true)));
    const expandedButton = Array.from(
      container.querySelectorAll("button")
    ).find((button) => button.textContent === "隐藏操作");
    expect(expandedButton?.closest("[inert]")).toBeNull();
    expect(expandedButton?.closest('[aria-hidden="true"]')).toBeNull();
  });

  it("keeps sortable source semantics on named drag handles", async () => {
    act(() => root.render(<AggregatedSourceSelect />));

    const setting = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]')
    ).find((element) => element.textContent?.includes("聚合音源"));
    act(() => setting?.click());
    await vi.dynamicImportSettled();
    await act(async () => {});

    const dragHandles = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-roledescription="sortable"]'
    );
    expect(dragHandles.length).toBeGreaterThan(0);
    for (const handle of dragHandles) {
      expect(handle.getAttribute("aria-label")).toMatch(/^拖动.+音源排序$/);
      expect(handle.querySelector("button, [role='checkbox']")).toBeNull();
    }

    for (const checkbox of container.querySelectorAll('[role="checkbox"]')) {
      expect(checkbox.getAttribute("aria-label")).toMatch(/^(启用|停用).+/);
    }
  });

  it("keeps tab triggers at least 44px tall", () => {
    act(() =>
      root.render(
        <Tabs defaultValue="one">
          <TabsList>
            <TabsTrigger value="one">第一项</TabsTrigger>
            <TabsTrigger value="two">第二项</TabsTrigger>
          </TabsList>
        </Tabs>
      )
    );

    for (const tab of container.querySelectorAll('[role="tab"]')) {
      expect(tab.className).toContain("min-h-11");
    }
  });
});
