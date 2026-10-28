import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Plectrum",
    short_name: "Plectrum",
    description: "Guitar chords from any song: link, upload or record.",
    start_url: "/",
    display: "standalone",
    background_color: "#12100e",
    theme_color: "#c2410c",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
