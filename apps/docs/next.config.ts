import type { NextConfig } from "next";

const gatewayPath = process.env.NEXT_PUBLIC_GATEWAY_PATH;

const nextConfig: NextConfig = {
  ...(gatewayPath ? { assetPrefix: gatewayPath } : {}),
  async rewrites() {
    if (!gatewayPath) {
      return [];
    }

    return [
      {
        source: `${gatewayPath}/:path*`,
        destination: "/:path*",
      },
    ];
  },
  turbopack: {
    root: new URL("../..", import.meta.url).pathname,
  },
};

export default nextConfig;
