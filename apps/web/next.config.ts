import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@pt-rcm/domain", "@pt-rcm/db", "@pt-rcm/rules"],
  webpack(config) {
    // Workspace sources use NodeNext's .js specifiers for TypeScript modules.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
