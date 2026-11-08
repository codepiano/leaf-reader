import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:1438",
    viewport: { width: 1180, height: 800 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm exec vite -- --host 127.0.0.1 --port 1438 --strictPort",
    url: "http://127.0.0.1:1438",
    reuseExistingServer: false,
  },
});
