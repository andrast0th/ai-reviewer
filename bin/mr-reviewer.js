#!/usr/bin/env node
// Plain JS so it runs (and can print a clear error) even on Node versions without type stripping.
const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  process.stderr.write(`mr-reviewer needs Node.js 24 or newer (running ${process.version}).\n`);
  process.exit(3);
}
const { main, defaultIo } = await import("../src/cli.ts");
process.exitCode = await main(defaultIo());
