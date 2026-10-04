import { defineConfig } from "vitest/config";

// Tests run against `ace-runtime`'s public API (resolved through the package name) and against
// this package's sources through relative imports. The app-server peer is always a scripted fake
// (see test/support/fake-app-server.ts); the real `codex` binary is exercised only by
// scripts/verify-live.ts, which skips when the binary is absent.
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
});
