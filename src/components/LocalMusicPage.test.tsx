import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LocalMusicPage } from "./LocalMusicPage";

describe("LocalMusicPage", () => {
  it("explains that historical device-local files are unavailable", () => {
    const { container } = render(
      <MemoryRouter>
        <LocalMusicPage onPlay={vi.fn()} isPlaying={false} />
      </MemoryRouter>
    );

    expect(container.textContent).toContain("浏览器无法读取原设备音乐目录");
    expect(container.textContent).toContain("旧版 Android 本地曲目记录");
  });
});
