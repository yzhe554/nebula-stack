import type { NextConfig } from "next";

const gatewayPath = process.env.NEXT_PUBLIC_GATEWAY_PATH;
const docsBasePath = "/docs";
const assetPrefix = gatewayPath ? `${gatewayPath}${docsBasePath}` : undefined;

const nextConfig: NextConfig = {
  basePath: docsBasePath,
  ...(assetPrefix ? { assetPrefix } : {}),
  async rewrites() {
    if (!gatewayPath) {
      return [];
    }

    return [
      {
        source: `${gatewayPath}${docsBasePath}/:path*`,
        destination: `${docsBasePath}/:path*`,
      },
    ];
  },
  turbopack: {
    root: new URL("../..", import.meta.url).pathname,
  },
};

export default nextConfig;
