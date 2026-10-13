import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ws has optional native add-ons (bufferutil, utf-8-validate) that the
  // bundler can't resolve; load it from node_modules at runtime instead.
  serverExternalPackages: ["ws", "pg"],
  async headers() {
    return [
      {
        // The service worker (#29) must never be served stale: a cached
        // copy would keep old notification handling for days. And it may
        // only run scripts from this origin.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
