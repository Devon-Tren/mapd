/**
 * policy.js — the command-policy classifier shared by chat and mcp. Every
 * dev command chat/mcp might run (npm test, git diff, ...) is classified
 * before it is ever spawned; anything not in the allowlist table below is
 * refused outright, regardless of classification.
 */

export const CLASS = {
  READ_ONLY: "read-only",
  VERIFICATION: "verification",
  PROJECT_MUTATION: "project-mutation",
  DEPENDENCY_MUTATION: "dependency-mutation",
  GIT_MUTATION: "git-mutation",
  DESTRUCTIVE: "destructive",
  NETWORKED: "networked",
};

/** Any of these may legitimately be "the project's package manager" — never assume it's npm. */
const PACKAGE_MANAGERS = new Set(["npm", "yarn", "pnpm", "bun"]);

/** Ordered rules — first match wins. `test` receives (cmd, args[]). */
const RULES = [
  { test: (c, a) => PACKAGE_MANAGERS.has(c) && a[0] === "test", classification: CLASS.VERIFICATION },
  { test: (c, a) => PACKAGE_MANAGERS.has(c) && a[0] === "run" && ["lint", "typecheck", "type-check", "build"].includes(a[1]), classification: CLASS.VERIFICATION },
  { test: (c, a) => PACKAGE_MANAGERS.has(c) && a[0] === "run" && ["dev", "start"].includes(a[1]), classification: CLASS.NETWORKED },
  { test: (c, a) => PACKAGE_MANAGERS.has(c) && a[0] === "start", classification: CLASS.NETWORKED },
  { test: (c, a) => PACKAGE_MANAGERS.has(c) && ["install", "ci", "update", "uninstall", "add", "remove"].includes(a[0]), classification: CLASS.DEPENDENCY_MUTATION },

  { test: (c, a) => c === "git" && ["status", "diff", "log", "show", "branch"].includes(a[0]), classification: CLASS.READ_ONLY },
  { test: (c, a) => c === "git" && a[0] === "push" && a.includes("--force"), classification: CLASS.DESTRUCTIVE },
  { test: (c, a) => c === "git" && ["push", "commit", "add", "checkout", "merge", "rebase"].includes(a[0]), classification: CLASS.GIT_MUTATION },
  { test: (c, a) => c === "git" && ["reset", "clean"].includes(a[0]) && (a.includes("--hard") || a.includes("-f") || a.includes("-fd")), classification: CLASS.DESTRUCTIVE },

  { test: (c) => ["grep", "rg", "find", "ls", "cat", "wc"].includes(c), classification: CLASS.READ_ONLY },
  { test: (c, a) => c === "rm", classification: CLASS.DESTRUCTIVE },
];

/** Returns `{ classification, allowed }` — `allowed: false` means "not in the allowlist, refuse outright." */
export function classifyCommand(cmd, args = []) {
  const rule = RULES.find((r) => r.test(cmd, args));
  if (!rule) return { classification: null, allowed: false, reason: `'${cmd}' is not an allowlisted command` };
  return { classification: rule.classification, allowed: true };
}

/**
 * Decide whether a classified command may run given the resolved config and
 * whether the caller has already obtained explicit human approval.
 */
export function isPermitted(classification, config, { approved = false } = {}) {
  switch (classification) {
    case CLASS.READ_ONLY:
    case CLASS.VERIFICATION:
      return { permitted: approved || config.chat?.autoRunReadOnly !== false, requiresApproval: false };
    case CLASS.PROJECT_MUTATION:
    case CLASS.DEPENDENCY_MUTATION:
    case CLASS.GIT_MUTATION:
      return { permitted: approved, requiresApproval: true };
    case CLASS.NETWORKED:
      return { permitted: approved && config.security?.allowNetworkCommands === true, requiresApproval: true };
    case CLASS.DESTRUCTIVE:
      return { permitted: approved && config.security?.allowDestructiveCommands === true, requiresApproval: true };
    default:
      return { permitted: false, requiresApproval: true };
  }
}
