import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { PageLayout } from "./PageLayout";

describe("PageLayout semantics", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("provides one main landmark after the page heading", () => {
    act(() =>
      root.render(
        <MemoryRouter>
          <PageLayout title="系统设置">
            <section>设置内容</section>
          </PageLayout>
        </MemoryRouter>
      )
    );

    expect(container.querySelectorAll("main")).toHaveLength(1);
    expect(container.querySelector("h1")?.textContent).toBe("系统设置");
    expect(container.querySelector("main")?.textContent).toContain("设置内容");
  });
});
