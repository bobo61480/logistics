import type { NextConfig } from "next";

// GitHub Pages build: fully static export served at the custom-domain root.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  trailingSlash: true,
};

export default nextConfig;
