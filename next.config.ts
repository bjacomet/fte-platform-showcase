import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  images: {
    // Resize creative previews (board cards + carousel slide thumbnails) at the
    // edge instead of shipping full 1080px originals into tiny boxes. Originals in
    // Supabase storage are untouched; Adviewer/downloads still use the full file.
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
    ],
  },
};

export default nextConfig;
