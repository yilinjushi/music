import { describe, expect, it, vi } from "vitest";
import { saveQrCanvasAsPng } from "@/lib/netease/qr-download";

describe("same-device NetEase QR flow", () => {
  it("downloads the rendered QR code as a PNG", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    const canvas = document.createElement("canvas");
    canvas.toBlob = vi.fn((callback, type) => {
      expect(type).toBe("image/png");
      callback(blob);
    });
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:qr-code");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    await expect(saveQrCanvasAsPng(canvas, 123)).resolves.toBe(true);
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:qr-code");
    expect(document.querySelector("a")).toBeNull();

    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
    click.mockRestore();
  });
});
