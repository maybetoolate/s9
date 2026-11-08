import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The shared core package ships TypeScript sources, so Next compiles it.
  transpilePackages: ['@s9/core'],
  output: 'standalone',
  // The API is reached through the runtime proxy in src/app/api/[...path].
  // A rewrite would bake the address of the API into the build, which would
  // tie the image to one environment.
};

export default nextConfig;
