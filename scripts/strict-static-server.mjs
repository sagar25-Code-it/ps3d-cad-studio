import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const root = resolve(projectRoot, "dist");
const port = Number(process.argv[2] ?? "4173");
const hosting = JSON.parse(await readFile(resolve(projectRoot, "vercel.json"), "utf8"));
const commonHeaders = headerRecord(hosting.headers.find((entry) => entry.source === "/(.*)")?.headers ?? []);
const assetHeaders = headerRecord(hosting.headers.find((entry) => entry.source === "/assets/(.*)")?.headers ?? []);
const types = new Map([
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"], [".txt", "text/plain; charset=utf-8"], [".map", "application/json"]
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const requested = decodeURIComponent(url.pathname);
    const asset = requested.startsWith("/assets/");
    const candidate = resolve(root, `.${requested}`);
    const safeCandidate = candidate.startsWith(`${root}\\`) || candidate.startsWith(`${root}/`) ? candidate : root;
    let file = safeCandidate;
    try {
      if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
    } catch {
      file = resolve(root, "index.html");
    }
    const bytes = await readFile(file);
    response.writeHead(200, {
      ...commonHeaders,
      ...(asset ? assetHeaders : {}),
      "Content-Type": types.get(extname(file)) ?? "application/octet-stream",
    });
    if (request.method === "HEAD") response.end();
    else response.end(bytes);
  } catch {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    response.end("Static smoke server failure.");
  }
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`Strict static smoke server listening on http://127.0.0.1:${port}\n`));

function headerRecord(headers) {
  return Object.fromEntries(headers.map((header) => [header.key, header.value]));
}
