import type { MetadataRoute } from "next";

// With this, "Add to Home Screen" opens Runway full screen with no browser address bar.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Runway",
    short_name: "Runway",
    description: "Tools, materials and equipment for small engineering teams: options researched, people decide.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#14532d",
    theme_color: "#14532d",
    icons: [
      { src: "/icons/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
