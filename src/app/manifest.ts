import type { MetadataRoute } from "next";

// What makes Data Ledger installable (#29): on an iPhone, Share → Add to
// Home Screen opens it full-screen like an app, which iOS requires before
// it allows push notifications. Served without a session (src/proxy.ts):
// it holds nothing but the name and icons.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Data Ledger",
    short_name: "Ledger",
    description: "A personal finance ledger.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fbf9f4",
    theme_color: "#171717",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
