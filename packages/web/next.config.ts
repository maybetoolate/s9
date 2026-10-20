import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The shared core package ships TypeScript sources, so Next compiles it.
  transpilePackages: ['@flowforge/core'],
  output: 'standalone',
  async rewrites() {
    return [
      // The browser talks to the API through the same origin in development.
      {
        source: '/api/:path*',
        destination: `${process.env.API_PUBLIC_URL ?? 'http://localhost:4100'}/api/:path*`,
      },
      {
        source: '/webhooks/:path*',
        destination: `${process.env.API_PUBLIC_URL ?? 'http://localhost:4100'}/webhooks/:path*`,
      },
    ];
  },
};

export default nextConfig;
