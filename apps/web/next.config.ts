import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb"
    }
  }
};

export default withSentryConfig(nextConfig, {
  telemetry: false,
  silent: true,
  sourcemaps: {
    disable: true
  },
  release: {
    create: false
  },
  suppressOnRouterTransitionStartWarning: true,
  webpack: {
    treeshake: {
      removeDebugLogging: true,
      removeTracing: true
    }
  }
});
