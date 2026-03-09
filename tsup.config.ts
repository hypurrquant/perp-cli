import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  dts: false,
  splitting: false,
  // Bundle workspace packages into the output so npx works
  noExternal: ["@pacifica/sdk"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
