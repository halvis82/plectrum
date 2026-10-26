import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    // model files are versioned by name, so they can be cached forever
    return [
      { source: "/model/:file*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      // cross-origin isolation lets the analysis worker use several threads; "credentialless" keeps
      // cross-origin images (thumbnails) loading without CORP headers
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
  serverExternalPackages: ["jsdom", "bgutils-js"],
  // the vendored yt-dlp challenge solver is read from disk at runtime
  outputFileTracingIncludes: { "/api/**": ["./src/lib/server/ejs/*.js"] },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    root: __dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
