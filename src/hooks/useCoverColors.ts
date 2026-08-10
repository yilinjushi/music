import { useState, useEffect, useRef } from "react";
import type { SwatchData } from "@/lib/utils/color";

interface UseCoverColorsResult {
  swatches: SwatchData[] | null;
  error: Error | null;
}

/**
 * 从封面图片 URL 提取调色板数据（含像素占比）。
 * 使用浏览器原生 Canvas，避免把 Node 图像处理依赖打进 PWA。
 */
export function useCoverColors(url: string | null): UseCoverColorsResult {
  const [swatches, setSwatches] = useState<SwatchData[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const latestUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!url) return;

    let cancelled = false;
    latestUrlRef.current = url;

    async function extract(imageUrl: string): Promise<SwatchData[]> {
      const image = await loadImage(imageUrl);
      return extractCanvasPalette(image);
    }

    extract(url)
      .then((result) => {
        if (!cancelled && latestUrlRef.current === url) {
          setSwatches(result);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled && latestUrlRef.current === url) {
          setSwatches(null);
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return { swatches, error };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.crossOrigin = "anonymous";

    const timeout = window.setTimeout(() => {
      image.src = "";
      reject(new Error("Cover image timed out"));
    }, 10_000);

    image.onload = () => {
      window.clearTimeout(timeout);
      resolve(image);
    };
    image.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("Cover image could not be loaded"));
    };
    image.src = url;
  });
}

/**
 * Downsample first, then quantize RGB into 16-level buckets. The result is
 * deterministic, fast enough for low-end phones, and intentionally small.
 */
export function extractCanvasPalette(image: HTMLImageElement): SwatchData[] {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (!sourceWidth || !sourceHeight) {
    throw new Error("Cover image has no dimensions");
  }

  const longestSide = 72;
  const scale = Math.min(1, longestSide / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D is unavailable");
  context.drawImage(image, 0, 0, width, height);

  const pixels = context.getImageData(0, 0, width, height).data;
  const buckets = new Map<
    string,
    { red: number; green: number; blue: number; population: number }
  >();

  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3];
    if (alpha < 192) continue;
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const key = `${red >> 4}-${green >> 4}-${blue >> 4}`;
    const bucket = buckets.get(key) ?? {
      red: 0,
      green: 0,
      blue: 0,
      population: 0,
    };
    bucket.red += red;
    bucket.green += green;
    bucket.blue += blue;
    bucket.population += 1;
    buckets.set(key, bucket);
  }

  return [...buckets.values()]
    .sort((left, right) => right.population - left.population)
    .slice(0, 12)
    .map(({ red, green, blue, population }) => ({
      hex: `#${[red, green, blue]
        .map((channel) =>
          Math.round(channel / population)
            .toString(16)
            .padStart(2, "0")
        )
        .join("")}`,
      population,
    }));
}
