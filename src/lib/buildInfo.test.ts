import { describe, it, expect } from "vitest";
import { buildInfoFromEnv, readBuildInfo, shortSha, BUILD_INFO, EMPTY_BUILD_INFO } from "./buildInfo";

const SHA = "A5D8CD6F00112233445566778899AABBCCDDEEFF";

describe("buildInfoFromEnv", () => {
  it("reads Vercel's system variables at build time", () => {
    const b = buildInfoFromEnv({
      VERCEL_GIT_COMMIT_SHA: SHA, VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_REPO_OWNER: "Danchappell7", VERCEL_GIT_REPO_SLUG: "Kora",
    }, { isBuild: true, now: new Date("2026-10-09T08:05:00Z") });
    expect(b).toEqual({ release: SHA.toLowerCase(), builtAt: "2026-10-09T08:05:00.000Z", vercelEnv: "production", branch: "main", repo: "Danchappell7/Kora" });
  });

  it("falls back to KANBO_RELEASE / GITHUB_SHA, and has no build time outside a build", () => {
    expect(buildInfoFromEnv({ KANBO_RELEASE: "abc1234" }, { isBuild: false }).release).toBe("abc1234");
    expect(buildInfoFromEnv({ GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567" }, { isBuild: false })).toMatchObject({ builtAt: null, vercelEnv: null, repo: null });
    expect(buildInfoFromEnv({}, { isBuild: false })).toEqual(EMPTY_BUILD_INFO);
  });

  it("drops anything that doesn't look right instead of shipping it", () => {
    const b = buildInfoFromEnv({
      VERCEL_GIT_COMMIT_SHA: "not-a-sha; rm -rf", VERCEL_ENV: "staging<script>", VERCEL_GIT_COMMIT_REF: "feat/x y",
      VERCEL_GIT_REPO_OWNER: "a/b", VERCEL_GIT_REPO_SLUG: "Kora",
    }, { isBuild: false });
    expect(b).toEqual(EMPTY_BUILD_INFO);
  });
});

describe("readBuildInfo", () => {
  it("coerces the define and never throws", () => {
    expect(readBuildInfo(null)).toEqual(EMPTY_BUILD_INFO);
    expect(readBuildInfo("x")).toEqual(EMPTY_BUILD_INFO);
    expect(readBuildInfo({ release: SHA, builtAt: "nope", vercelEnv: "preview" })).toMatchObject({ release: SHA.toLowerCase(), builtAt: null, vercelEnv: "preview" });
    expect(Object.keys(BUILD_INFO).sort()).toEqual(["branch", "builtAt", "release", "repo", "vercelEnv"]);
    expect(shortSha(SHA.toLowerCase())).toBe("a5d8cd6");
    expect(shortSha(null)).toBeNull();
  });
});
