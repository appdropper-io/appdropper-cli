/**
 * Who ran this upload. Every field is optional and cosmetic: App Dropper
 * quotes it back in the "a new version is available" email it sends the app's
 * testers and managers, so a reader can tell at a glance which pipeline,
 * branch and commit the build in their hands came from.
 *
 * Nothing here is a credential and nothing here is trusted server-side — the
 * token decides what the upload may do, this only decides what the email says.
 */
export interface CiInfo {
  provider?: string;
  repo?: string;
  branch?: string;
  commit?: string;
  actor?: string;
  run_url?: string;
}

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
};

/** First defined variable wins, so newer names can shadow legacy ones. */
const first = (...names: string[]): string | undefined => {
  for (const name of names) {
    const value = env(name);
    if (value) return value;
  }
  return undefined;
};

/** Turns "git@github.com:acme/app.git" or a URL into "acme/app". */
function repoSlug(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return match ? match[1] : undefined;
}

/**
 * "refs/heads/main" -> "main", and Jenkins' "origin/main" -> "main".
 * Anything else is passed through untouched.
 */
function branchName(ref: string | undefined): string | undefined {
  return ref?.replace(/^refs\/(heads|tags)\//, "").replace(/^origin\//, "");
}

interface Detector {
  /** Set (to anything) only inside this CI system. */
  when: string;
  detect: () => CiInfo;
}

/**
 * Ordered most-specific first. Several systems also set the generic `CI`
 * variable, so the catch-all at the bottom only runs when nothing above it
 * recognised the environment.
 */
const DETECTORS: Detector[] = [
  {
    when: "GITHUB_ACTIONS",
    detect: () => {
      const repo = env("GITHUB_REPOSITORY");
      const runId = env("GITHUB_RUN_ID");
      const server = env("GITHUB_SERVER_URL") ?? "https://github.com";
      return {
        provider: "GitHub Actions",
        repo,
        branch: branchName(first("GITHUB_HEAD_REF", "GITHUB_REF_NAME", "GITHUB_REF")),
        commit: env("GITHUB_SHA"),
        actor: env("GITHUB_ACTOR"),
        run_url: repo && runId ? `${server}/${repo}/actions/runs/${runId}` : undefined,
      };
    },
  },
  {
    when: "GITLAB_CI",
    detect: () => ({
      provider: "GitLab CI",
      repo: env("CI_PROJECT_PATH"),
      branch: first("CI_COMMIT_BRANCH", "CI_COMMIT_REF_NAME"),
      commit: env("CI_COMMIT_SHA"),
      actor: first("GITLAB_USER_LOGIN", "GITLAB_USER_NAME"),
      run_url: first("CI_JOB_URL", "CI_PIPELINE_URL"),
    }),
  },
  {
    when: "BITRISE_IO",
    detect: () => ({
      provider: "Bitrise",
      repo: repoSlug(env("GIT_REPOSITORY_URL")) ?? env("BITRISE_APP_TITLE"),
      branch: first("BITRISE_GIT_BRANCH", "BITRISEIO_GIT_BRANCH_DEST"),
      commit: env("BITRISE_GIT_COMMIT"),
      run_url: env("BITRISE_BUILD_URL"),
    }),
  },
  {
    when: "CIRCLECI",
    detect: () => {
      const owner = env("CIRCLE_PROJECT_USERNAME");
      const name = env("CIRCLE_PROJECT_REPONAME");
      return {
        provider: "CircleCI",
        repo: owner && name ? `${owner}/${name}` : name,
        branch: env("CIRCLE_BRANCH"),
        commit: env("CIRCLE_SHA1"),
        actor: env("CIRCLE_USERNAME"),
        run_url: env("CIRCLE_BUILD_URL"),
      };
    },
  },
  {
    when: "BITBUCKET_BUILD_NUMBER",
    detect: () => {
      const repo = env("BITBUCKET_REPO_FULL_NAME");
      const build = env("BITBUCKET_BUILD_NUMBER");
      return {
        provider: "Bitbucket Pipelines",
        repo,
        branch: first("BITBUCKET_BRANCH", "BITBUCKET_TAG"),
        commit: env("BITBUCKET_COMMIT"),
        run_url:
          repo && build
            ? `https://bitbucket.org/${repo}/pipelines/results/${build}`
            : undefined,
      };
    },
  },
  {
    when: "BUILDKITE",
    detect: () => ({
      provider: "Buildkite",
      repo: repoSlug(env("BUILDKITE_REPO")),
      branch: env("BUILDKITE_BRANCH"),
      commit: env("BUILDKITE_COMMIT"),
      actor: env("BUILDKITE_BUILD_CREATOR"),
      run_url: env("BUILDKITE_BUILD_URL"),
    }),
  },
  {
    when: "TRAVIS",
    detect: () => ({
      provider: "Travis CI",
      repo: env("TRAVIS_REPO_SLUG"),
      branch: first("TRAVIS_PULL_REQUEST_BRANCH", "TRAVIS_BRANCH"),
      commit: env("TRAVIS_COMMIT"),
      run_url: env("TRAVIS_BUILD_WEB_URL"),
    }),
  },
  {
    when: "TF_BUILD",
    detect: () => {
      const collection = env("SYSTEM_TEAMFOUNDATIONCOLLECTIONURI");
      const project = env("SYSTEM_TEAMPROJECT");
      const buildId = env("BUILD_BUILDID");
      return {
        provider: "Azure Pipelines",
        repo: env("BUILD_REPOSITORY_NAME"),
        branch: branchName(first("BUILD_SOURCEBRANCHNAME", "BUILD_SOURCEBRANCH")),
        commit: env("BUILD_SOURCEVERSION"),
        actor: env("BUILD_REQUESTEDFOR"),
        run_url:
          collection && project && buildId
            ? `${collection.replace(/\/+$/, "")}/${project}/_build/results?buildId=${buildId}`
            : undefined,
      };
    },
  },
  {
    when: "CM_BUILD_ID",
    detect: () => ({
      provider: "Codemagic",
      repo: first("CM_REPO_SLUG", "FCI_REPO_SLUG"),
      branch: first("CM_BRANCH", "FCI_BRANCH"),
      commit: first("CM_COMMIT", "FCI_COMMIT"),
      run_url: first("CM_BUILD_URL", "FCI_BUILD_URL"),
    }),
  },
  {
    when: "JENKINS_URL",
    detect: () => ({
      provider: "Jenkins",
      repo: repoSlug(first("GIT_URL", "GIT_URL_1")) ?? env("JOB_NAME"),
      branch: branchName(first("BRANCH_NAME", "GIT_BRANCH")),
      commit: env("GIT_COMMIT"),
      run_url: env("BUILD_URL"),
    }),
  },
  {
    when: "TEAMCITY_VERSION",
    detect: () => ({
      provider: "TeamCity",
      branch: branchName(env("BUILD_VCS_BRANCH")),
      commit: env("BUILD_VCS_NUMBER"),
    }),
  },
  {
    // Anything else that only announces itself as "a CI runner".
    when: "CI",
    detect: () => ({ provider: "CI" }),
  },
];

/**
 * Describes the pipeline this process is running in, or `undefined` on a
 * developer's laptop. `APPDROPPER_NO_CI_INFO=1` opts out entirely, for anyone
 * who would rather not put a branch name in a tester's inbox.
 */
export function detectCi(): CiInfo | undefined {
  if (env("APPDROPPER_NO_CI_INFO")) return undefined;
  const detector = DETECTORS.find((d) => env(d.when));
  if (!detector) return undefined;
  const info = detector.detect();
  // Drop the empty keys so the request body carries only what we actually know.
  const cleaned = Object.fromEntries(
    Object.entries(info).filter(([, value]) => Boolean(value))
  ) as CiInfo;
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}
