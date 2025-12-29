import { defineConfig } from "@rslib/core";

export default defineConfig({
  source: {
    entry: {
      index: "src/index.ts",
      runtime: "src/runtime.ts",
    },
  },
  lib: [
    {
      format: "esm",
      syntax: "es2021",
      dts: true,
    },
    {
      format: "esm",
      syntax: "es2021",
      output: {
        target: "web",
        minify: true,
        filename: {
          js: "[name].min.js",
        },
      },
    },
  ],
});
