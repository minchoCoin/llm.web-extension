import { cp, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await cp("public", "dist", { recursive: true });
await mkdir("dist/vendor", { recursive: true });
await cp("node_modules/marked/lib/marked.umd.js", "dist/vendor/marked.umd.js");
await cp("node_modules/katex/dist/katex.min.js", "dist/vendor/katex.min.js");
await cp("node_modules/katex/dist/contrib/auto-render.min.js", "dist/vendor/auto-render.min.js");
await cp("node_modules/katex/dist/katex.min.css", "dist/vendor/katex.min.css");
await cp("node_modules/katex/dist/fonts", "dist/vendor/fonts", { recursive: true });
