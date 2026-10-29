/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // le package partagé est livré en TypeScript source
  transpilePackages: ["@chessarena/shared"],
};
