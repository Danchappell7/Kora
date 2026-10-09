/* ============================================================
   KANBO — which build is running.                              [w9-ops]
   vite.config.ts turns the build environment into one constant,
   __KANBO_BUILD__ (a Vite define), using buildInfoFromEnv() below:

     release   the commit (VERCEL_GIT_COMMIT_SHA on Vercel; KANBO_RELEASE
               or GITHUB_SHA elsewhere) — Sentry's release tag and the
               /admin System status "Running build" line
     builtAt   when `vite build` ran (null for the dev server and tests)
     vercelEnv production | preview | development (VERCEL_ENV)
     branch    VERCEL_GIT_COMMIT_REF
     repo      "owner/slug" on GitHub (VERCEL_GIT_REPO_OWNER/_SLUG)

   Vercel exposes these "system environment variables" to the build
   while Project › Settings › Environment Variables › "Automatically
   expose System Environment Variables" is on (the default). Nothing
   here is a secret: it all ships in the bundle.
   No imports: vite.config.ts loads this file in Node.
   ============================================================ */

export interface BuildInfo {
  /** the commit this build was made from (lower-case hex); null for a local build */
  release: string | null;
  /** when `vite build` ran (ISO); null outside a build */
  builtAt: string | null;
  /** Vercel's environment: "production" | "preview" | "development"; null off Vercel */
  vercelEnv: string | null;
  /** the git branch the build came from; null when unknown */
  branch: string | null;
  /** "owner/slug" of the GitHub repository; null when unknown */
  repo: string | null;
}

export const EMPTY_BUILD_INFO: BuildInfo = { release: null, builtAt: null, vercelEnv: null, branch: null, repo: null };

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const VERCEL_ENVS = new Set(["production", "preview", "development"]);
const SLUG_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]{1,120}$/;

const clean = (v: string | undefined | null): string | null => {
  const s = (v ?? "").trim();
  return s ? s : null;
};

/** The build's identity from its environment (process.env at build time). Anything
 *  that doesn't look right is dropped rather than shipped. */
export function buildInfoFromEnv(env: Record<string, string | undefined>, opts: { isBuild: boolean; now?: Date }): BuildInfo {
  const sha = [env.VERCEL_GIT_COMMIT_SHA, env.KANBO_RELEASE, env.GITHUB_SHA].map(clean).find((s) => !!s && SHA_RE.test(s)) ?? null;
  const vercelEnv = clean(env.VERCEL_ENV);
  const owner = clean(env.VERCEL_GIT_REPO_OWNER);
  const slug = clean(env.VERCEL_GIT_REPO_SLUG);
  const branch = clean(env.VERCEL_GIT_COMMIT_REF);
  return {
    release: sha ? sha.toLowerCase() : null,
    builtAt: opts.isBuild ? (opts.now ?? new Date()).toISOString() : null,
    vercelEnv: vercelEnv && VERCEL_ENVS.has(vercelEnv) ? vercelEnv : null,
    branch: branch && BRANCH_RE.test(branch) ? branch : null,
    repo: owner && slug && SLUG_RE.test(owner) && SLUG_RE.test(slug) ? `${owner}/${slug}` : null,
  };
}

/** Coerce whatever the define holds into a BuildInfo (never throws). */
export function readBuildInfo(raw: unknown): BuildInfo {
  if (!raw || typeof raw !== "object") return { ...EMPTY_BUILD_INFO };
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const release = str(o.release);
  const builtAt = str(o.builtAt);
  return {
    release: release && SHA_RE.test(release) ? release.toLowerCase() : null,
    builtAt: builtAt && !Number.isNaN(Date.parse(builtAt)) ? builtAt : null,
    vercelEnv: str(o.vercelEnv),
    branch: str(o.branch),
    repo: str(o.repo),
  };
}

/** The running build (the Vite define; empty in a context without it). */
export const BUILD_INFO: BuildInfo = readBuildInfo(typeof __KANBO_BUILD__ !== "undefined" ? __KANBO_BUILD__ : null);

/** The first seven characters of a commit, as GitHub shows it. */
export const shortSha = (sha: string | null | undefined): string | null => (sha ? sha.slice(0, 7) : null);
