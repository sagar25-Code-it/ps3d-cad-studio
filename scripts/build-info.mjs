import { execFileSync } from "node:child_process";

/**
 * Build identity. The same object is compiled into the app (Vite `define`) and written to dist/version.json, so a running tab can
 * ask the server which build is live and tell whether it is the one it is running. The commit is the only part that varies per
 * deploy; it cannot live in the tracked sources because committing would change it.
 */

export const BUILD_INFO_SCHEMA = "ps3d-build-info-v1";
const FULL_SHA = /^[0-9a-f]{40}$/u;
const ANY_SHA = /^[0-9a-f]{7,64}$/u;

/** HEAD of the checkout, or undefined outside a git checkout (a source tarball, a CI cache without .git). */
export function gitHead(cwd = process.cwd()) {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).toString("utf8").trim().toLowerCase();
    return FULL_SHA.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Picks the commit: VERCEL_GIT_COMMIT_SHA on a Vercel build, else `git rev-parse HEAD`, else "dev".
 * `git` is injectable so tests do not need a repository.
 */
export function resolveBuildInfo({ env = process.env, now = new Date(), git = gitHead, version = "0.0.0" } = {}) {
  const vercelSha = typeof env.VERCEL_GIT_COMMIT_SHA === "string" ? env.VERCEL_GIT_COMMIT_SHA.trim().toLowerCase() : "";
  let commit = "dev";
  let source = "dev";
  if (ANY_SHA.test(vercelSha)) {
    commit = vercelSha;
    source = "vercel";
  } else {
    const head = git();
    if (head !== undefined && ANY_SHA.test(head)) {
      commit = head;
      source = "git";
    }
  }
  return {
    schema: BUILD_INFO_SCHEMA,
    version,
    commit,
    commitShort: commit === "dev" ? "dev" : commit.slice(0, 7),
    builtAt: now.toISOString(),
    source
  };
}

/** Vite plugin: emits dist/version.json and serves the same document from the dev server. */
export function buildInfoPlugin(info) {
  const body = `${JSON.stringify(info, null, 2)}\n`;
  return {
    name: "ps3d-build-info",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? "/").split("?")[0];
        if (pathname !== "/version.json") {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(request.method === "HEAD" ? undefined : body);
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: body });
    }
  };
}
