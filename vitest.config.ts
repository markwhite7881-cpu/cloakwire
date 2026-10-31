import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Core harness tests run under node:test and own native child processes.
// Keep them out of Vitest's browser/application discovery.
export default mergeConfig(viteConfig, defineConfig({
  test: { exclude: [...configDefaults.exclude, "scripts/connection-matrix/**"] },
}));
