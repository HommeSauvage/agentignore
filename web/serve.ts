import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const root = import.meta.dir;
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = Bun.serve({
  port: 3000,
  hostname: "0.0.0.0",
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = join(root, path);
    if (!file.startsWith(root) || !existsSync(file)) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(readFileSync(file), {
      headers: { "Content-Type": types[extname(file)] ?? "application/octet-stream" },
    });
  },
});

console.log(`agentignore.org preview: http://0.0.0.0:${server.port}`);
