import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    // model files are versioned by name, so they can be cached forever
    return [
      { source: "/model/:file*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      { source: "/guitar/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      { source: "/ort/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      // cross-origin isolation lets the analysis worker use several threads; "credentialless" keeps
      // cross-origin images (thumbnails) loading without CORP headers
      { source: "/:path*", headers: [{ key: "Cross-Origin-Embedder-Policy", value: "credentialless" }] },
      // except where the old addresses hand their saved audio over (src/lib/moved.ts): that needs a
      // window that can still message the page that opened it
      {
        source: "/((?!move$).*)",
        missing: [{ type: "host", value: "(chordcatch-seven|chord-catch|chordcatch-personal-0972)\\.vercel\\.app" }],
        headers: [{ key: "Cross-Origin-Opener-Policy", value: "same-origin" }],
      },
      // WebKit (Safari, and every browser on iPhone) has no "credentialless", so without this it
      // runs the note model on one thread. Its only cross-origin images are YouTube thumbnails,
      // which send CORP; other cover art goes through /api/thumb.
      {
        source: "/:path*",
        has: [{ type: "header", key: "user-agent", value: "^(?!.*(Chrome/|Chromium/|Firefox/)).*AppleWebKit.*$" }],
        headers: [{ key: "Cross-Origin-Embedder-Policy", value: "require-corp" }],
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
