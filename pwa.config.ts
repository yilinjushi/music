import type { ManifestOptions } from "vite-plugin-pwa";

export const pwaManifest: Partial<ManifestOptions> = {
  id: "/",
  name: "Music PWA",
  short_name: "Music",
  description: "无广告的移动端网页音乐播放器",
  lang: "zh-CN",
  theme_color: "#0a0a0a",
  background_color: "#0a0a0a",
  display: "standalone",
  start_url: "/",
  scope: "/",
  categories: ["music", "entertainment"],
  icons: [
    {
      src: "/pwa-192x192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/pwa-512x512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/pwa-maskable-512x512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
};
