import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ws has optional native add-ons (bufferutil, utf-8-validate) that the
  // bundler can't resolve; load it from node_modules at runtime instead.
  serverExternalPackages: ["ws", "pg"],
};

export default nextConfig;
