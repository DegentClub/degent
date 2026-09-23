/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emits .next/standalone for the slim Docker runtime stage.
  output: 'standalone',
  poweredByHeader: false,
};

export default nextConfig;
