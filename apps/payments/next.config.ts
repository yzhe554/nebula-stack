import type { NextConfig } from "next";

const gatewayPath = process.env.NEXT_PUBLIC_GATEWAY_PATH;
const paymentsBasePath = "/payments";
const assetPrefix = gatewayPath ? `${gatewayPath}${paymentsBasePath}` : undefined;

const nextConfig: NextConfig = {
  basePath: paymentsBasePath,
  output: "standalone",
  ...(assetPrefix ? { assetPrefix } : {}),
  async rewrites() {
    if (!gatewayPath) {
      return [];
    }

    return [
      {
        source: `${gatewayPath}${paymentsBasePath}/:path*`,
        destination: `${paymentsBasePath}/:path*`,
      },
    ];
  },
  turbopack: {
    root: new URL("../..", import.meta.url).pathname,
  },
};

export default nextConfig;
