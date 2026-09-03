import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, vitest],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: ["eslint-plugin-crap"],
  overrides: [
    {
      files: ["src/**/*.{ts,tsx,js,jsx}"],
      rules: {
        "crap/crap": ["error", { lcovPath: "coverage/lcov.info", maxCrap: 8 }],
      },
    },
  ],
});
