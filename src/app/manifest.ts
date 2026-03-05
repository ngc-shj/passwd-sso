import type { MetadataRoute } from "next";
import { BASE_PATH } from "@/lib/url-helpers";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "passwd-sso",
    short_name: "passwd-sso",
    icons: [
      {
        src: `${BASE_PATH}/icon-192.png`,
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: `${BASE_PATH}/icon-512.png`,
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: `${BASE_PATH}/icon.svg`,
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
    theme_color: "#5B57D6",
    background_color: "#ffffff",
    display: "standalone",
  };
}
