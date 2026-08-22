"use strict";
/**
 * Covers ci.ts: detectCi() reading each CI provider's environment variables
 * into the CiInfo the API quotes back in a build's "new version" email.
 */
const path = require("path");
const assert = require("assert");

const DIST = path.resolve(__dirname, "..", "dist");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ci.ts has no external dependencies, so each test can just set process.env,
// re-require it fresh (module cache is irrelevant — nothing is memoized at
// module load), and restore the environment afterward.
const ENV_KEYS = [
  "APPDROPPER_NO_CI_INFO", "CI", "GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_RUN_ID",
  "GITHUB_SERVER_URL", "GITHUB_HEAD_REF", "GITHUB_REF_NAME", "GITHUB_REF", "GITHUB_SHA",
  "GITHUB_ACTOR", "GITLAB_CI", "CI_PROJECT_PATH", "CI_COMMIT_BRANCH", "CI_COMMIT_REF_NAME",
  "CI_COMMIT_SHA", "GITLAB_USER_LOGIN", "GITLAB_USER_NAME", "CI_JOB_URL", "CI_PIPELINE_URL",
  "BITRISE_IO", "GIT_REPOSITORY_URL", "BITRISE_APP_TITLE", "BITRISE_GIT_BRANCH",
  "BITRISEIO_GIT_BRANCH_DEST", "BITRISE_GIT_COMMIT", "BITRISE_BUILD_URL", "CIRCLECI",
  "CIRCLE_PROJECT_USERNAME", "CIRCLE_PROJECT_REPONAME", "CIRCLE_BRANCH", "CIRCLE_SHA1",
  "CIRCLE_USERNAME", "CIRCLE_BUILD_URL", "BITBUCKET_BUILD_NUMBER", "BITBUCKET_REPO_FULL_NAME",
  "BITBUCKET_BRANCH", "BITBUCKET_TAG", "BITBUCKET_COMMIT", "BUILDKITE", "BUILDKITE_REPO",
  "BUILDKITE_BRANCH", "BUILDKITE_COMMIT", "BUILDKITE_BUILD_CREATOR", "BUILDKITE_BUILD_URL",
  "TRAVIS", "TRAVIS_REPO_SLUG", "TRAVIS_PULL_REQUEST_BRANCH", "TRAVIS_BRANCH", "TRAVIS_COMMIT",
  "TRAVIS_BUILD_WEB_URL", "TF_BUILD", "SYSTEM_TEAMFOUNDATIONCOLLECTIONURI", "SYSTEM_TEAMPROJECT",
  "BUILD_BUILDID", "BUILD_REPOSITORY_NAME", "BUILD_SOURCEBRANCHNAME", "BUILD_SOURCEBRANCH",
  "BUILD_SOURCEVERSION", "BUILD_REQUESTEDFOR", "CM_BUILD_ID", "CM_REPO_SLUG", "FCI_REPO_SLUG",
  "CM_BRANCH", "FCI_BRANCH", "CM_COMMIT", "FCI_COMMIT", "CM_BUILD_URL", "FCI_BUILD_URL",
  "JENKINS_URL", "GIT_URL", "GIT_URL_1", "JOB_NAME", "BRANCH_NAME", "GIT_BRANCH", "GIT_COMMIT",
  "BUILD_URL", "TEAMCITY_VERSION", "BUILD_VCS_BRANCH", "BUILD_VCS_NUMBER",
];

function withEnv(vars, fn) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, vars);
  try {
    delete require.cache[require.resolve(path.join(DIST, "ci.js"))];
    const { detectCi } = require(path.join(DIST, "ci.js"));
    return fn(detectCi);
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("returns undefined on a plain developer laptop", () => {
  withEnv({}, (detectCi) => {
    assert.strictEqual(detectCi(), undefined);
  });
});

test("APPDROPPER_NO_CI_INFO opts out even inside a real CI run", () => {
  withEnv(
    { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/app", APPDROPPER_NO_CI_INFO: "1" },
    (detectCi) => {
      assert.strictEqual(detectCi(), undefined);
    }
  );
});

test("GitHub Actions: builds the run URL and strips the refs/heads/ prefix", () => {
  withEnv(
    {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "acme/checkout-app",
      GITHUB_RUN_ID: "42",
      GITHUB_REF_NAME: "refs/heads/main",
      GITHUB_SHA: "a1b2c3d",
      GITHUB_ACTOR: "octocat",
    },
    (detectCi) => {
      const info = detectCi();
      assert.deepStrictEqual(info, {
        provider: "GitHub Actions",
        repo: "acme/checkout-app",
        branch: "main",
        commit: "a1b2c3d",
        actor: "octocat",
        run_url: "https://github.com/acme/checkout-app/actions/runs/42",
      });
    }
  );
});

test("GitHub Actions: a PR prefers GITHUB_HEAD_REF over GITHUB_REF_NAME", () => {
  withEnv(
    {
      GITHUB_ACTIONS: "true",
      GITHUB_HEAD_REF: "feature/login",
      GITHUB_REF_NAME: "42/merge",
    },
    (detectCi) => {
      assert.strictEqual(detectCi().branch, "feature/login");
    }
  );
});

test("GitHub Actions: honors a custom GITHUB_SERVER_URL (GHE)", () => {
  withEnv(
    {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_RUN_ID: "9",
      GITHUB_SERVER_URL: "https://github.acme.internal",
    },
    (detectCi) => {
      assert.strictEqual(
        detectCi().run_url,
        "https://github.acme.internal/acme/app/actions/runs/9"
      );
    }
  );
});

test("GitLab CI reads its own variable set", () => {
  withEnv(
    {
      GITLAB_CI: "true",
      CI_PROJECT_PATH: "acme/app",
      CI_COMMIT_BRANCH: "main",
      CI_COMMIT_SHA: "deadbeef",
      GITLAB_USER_LOGIN: "jane",
      CI_JOB_URL: "https://gitlab.com/acme/app/-/jobs/1",
    },
    (detectCi) => {
      assert.deepStrictEqual(detectCi(), {
        provider: "GitLab CI",
        repo: "acme/app",
        branch: "main",
        commit: "deadbeef",
        actor: "jane",
        run_url: "https://gitlab.com/acme/app/-/jobs/1",
      });
    }
  );
});

test("Bitrise falls back to the app title and derives the repo slug from a git URL", () => {
  withEnv(
    {
      BITRISE_IO: "true",
      GIT_REPOSITORY_URL: "git@github.com:acme/app.git",
      BITRISE_GIT_BRANCH: "develop",
      BITRISE_GIT_COMMIT: "cafebabe",
      BITRISE_BUILD_URL: "https://bitrise.io/build/1",
    },
    (detectCi) => {
      assert.strictEqual(detectCi().provider, "Bitrise");
      assert.strictEqual(detectCi().repo, "acme/app");
    }
  );
});

test("CircleCI joins the username/reponame pair", () => {
  withEnv(
    { CIRCLECI: "true", CIRCLE_PROJECT_USERNAME: "acme", CIRCLE_PROJECT_REPONAME: "app" },
    (detectCi) => {
      assert.strictEqual(detectCi().repo, "acme/app");
    }
  );
});

test("Bitbucket Pipelines composes the run URL from repo + build number", () => {
  withEnv(
    {
      BITBUCKET_BUILD_NUMBER: "17",
      BITBUCKET_REPO_FULL_NAME: "acme/app",
      BITBUCKET_BRANCH: "main",
      BITBUCKET_COMMIT: "abc123",
    },
    (detectCi) => {
      assert.strictEqual(
        detectCi().run_url,
        "https://bitbucket.org/acme/app/pipelines/results/17"
      );
    }
  );
});

test("Buildkite derives a repo slug from an SSH-style git URL", () => {
  withEnv(
    { BUILDKITE: "true", BUILDKITE_REPO: "git@github.com:acme/app.git", BUILDKITE_BRANCH: "main" },
    (detectCi) => {
      assert.strictEqual(detectCi().repo, "acme/app");
    }
  );
});

test("Travis CI prefers the PR branch over the base branch", () => {
  withEnv(
    {
      TRAVIS: "true",
      TRAVIS_REPO_SLUG: "acme/app",
      TRAVIS_BRANCH: "main",
      TRAVIS_PULL_REQUEST_BRANCH: "feature/x",
    },
    (detectCi) => {
      assert.strictEqual(detectCi().branch, "feature/x");
    }
  );
});

test("Azure Pipelines strips a trailing slash from the collection URL", () => {
  withEnv(
    {
      TF_BUILD: "true",
      SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: "https://dev.azure.com/acme/",
      SYSTEM_TEAMPROJECT: "app",
      BUILD_BUILDID: "5",
      BUILD_SOURCEBRANCHNAME: "main",
    },
    (detectCi) => {
      assert.strictEqual(
        detectCi().run_url,
        "https://dev.azure.com/acme/app/_build/results?buildId=5"
      );
      assert.strictEqual(detectCi().branch, "main");
    }
  );
});

test("Codemagic falls back to the FCI_* legacy variable names", () => {
  withEnv(
    { CM_BUILD_ID: "1", FCI_REPO_SLUG: "acme/app", FCI_BRANCH: "main" },
    (detectCi) => {
      assert.strictEqual(detectCi().provider, "Codemagic");
      assert.strictEqual(detectCi().repo, "acme/app");
      assert.strictEqual(detectCi().branch, "main");
    }
  );
});

test("Jenkins strips origin/ and falls back to JOB_NAME when there's no git URL", () => {
  withEnv(
    { JENKINS_URL: "https://ci.acme.internal", JOB_NAME: "app-build", GIT_BRANCH: "origin/main" },
    (detectCi) => {
      assert.strictEqual(detectCi().repo, "app-build");
      assert.strictEqual(detectCi().branch, "main");
    }
  );
});

test("TeamCity has no repo field, only branch and commit", () => {
  withEnv(
    { TEAMCITY_VERSION: "2023.1", BUILD_VCS_BRANCH: "refs/heads/main", BUILD_VCS_NUMBER: "abc" },
    (detectCi) => {
      assert.deepStrictEqual(detectCi(), { provider: "TeamCity", branch: "main", commit: "abc" });
    }
  );
});

test("an unrecognized CI system still reports generically via the bare CI variable", () => {
  withEnv({ CI: "true" }, (detectCi) => {
    assert.deepStrictEqual(detectCi(), { provider: "CI" });
  });
});

test("more specific detectors are checked before the generic CI fallback", () => {
  withEnv({ CI: "true", GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/app" }, (detectCi) => {
    assert.strictEqual(detectCi().provider, "GitHub Actions");
  });
});

test("empty-string env vars are dropped, not kept as empty fields", () => {
  withEnv({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/app", GITHUB_ACTOR: "  " }, (detectCi) => {
    assert.strictEqual("actor" in detectCi(), false);
  });
});

(async () => {
  let failed = 0;
  console.log("\nCI provider detection\n");
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}\n      ${err.message}`);
    }
  }
  console.log(failed ? `\n${failed} failing, ${tests.length - failed} passing\n` : `\n${tests.length} passing\n`);
  process.exit(failed ? 1 : 0);
})();
