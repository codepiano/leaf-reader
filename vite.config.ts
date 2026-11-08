import { defineConfig } from "vite";

// Keep browser tests and desktop development under the same CSP restrictions as
// the release app. An opaque iframe needs an explicit app-owned bridge URL;
// inherited 'self' alone intentionally does not match its isolated origin.
export default defineConfig({
  server: {
    headers: {
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' http://127.0.0.1:1437/reader-bridge.js http://127.0.0.1:1438/reader-bridge.js; style-src 'self' 'unsafe-inline' epub: http://epub.localhost; img-src 'self' data: epub: http://epub.localhost; font-src 'self' data: epub: http://epub.localhost; connect-src 'self' data: ipc: http://ipc.localhost ws://127.0.0.1:1437 ws://127.0.0.1:1438; frame-src 'self'; object-src 'none'; base-uri 'self' epub: http://epub.localhost",
    },
  },
});
