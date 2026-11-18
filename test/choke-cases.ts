/**
 * The choke's shared case table — ONE table, TWO implementations judged by it
 * (`src/choke.ts` and `plugin/bin/git-refusals.mjs`, in test/choke.test.ts and
 * test/git-shim.test.ts), so the plain-JS mirror cannot drift.
 *
 * Every case pair is ticket 01's exact-token contract: the refused forms of
 * each destruction class, and the benign neighbors that must stay clear (the
 * live corpus never goes darker than status/branch -a/log/diff/checkout -b/
 * add/commit). An allow case that flips to refuse is a false positive with
 * the same weight as a miss (the map's pre-registered rules).
 */
import { writableRootsFor } from "../src/choke.ts";

/** argv AFTER the `git` word → the rule that must fire, or null for pass-through. */
export const GIT_ARGV_CASES: readonly { argv: readonly string[]; rule: string | null; note?: string }[] = [
  // rule 1 — push that rewinds/deletes remote refs
  { argv: ["push", "--force", "origin", "main"], rule: "git:force-push" },
  { argv: ["push", "--force-only"], rule: "git:force-push" },
  { argv: ["push", "--delete", "origin", "main"], rule: "git:force-push" },
  { argv: ["push", "-f"], rule: "git:force-push" },
  { argv: ["push", "-d", "origin", "old"], rule: "git:force-push" },
  { argv: ["push", "-fq", "origin", "main"], rule: "git:force-push" },
  { argv: ["push", "origin", "+main:main"], rule: "git:force-push" },
  { argv: ["push", "origin", ":old"], rule: "git:force-push" },
  { argv: ["push", "origin", "main"], rule: null, note: "plain push — the daily flow" },
  { argv: ["push", "--force-with-lease", "origin", "main"], rule: null, note: "distinct token, lease-holding" },
  { argv: ["push", "-u", "origin", "main"], rule: null },
  { argv: ["push", "origin", "main:main"], rule: null, note: "colon inside, not leading — not a delete" },
  { argv: ["push", "origin", "HEAD:main"], rule: null },
  { argv: ["fetch", "-f", "origin"], rule: null, note: "the rule is per-subcommand" },
  { argv: ["fetch", "--force", "origin"], rule: null },

  // rule 2 — reset --hard
  { argv: ["reset", "--hard"], rule: "git:reset-hard" },
  { argv: ["reset", "--hard", "HEAD~1"], rule: "git:reset-hard" },
  { argv: ["reset", "HEAD~1", "--hard"], rule: "git:reset-hard" },
  { argv: ["reset", "--soft", "HEAD~1"], rule: null },
  { argv: ["reset", "HEAD", "file.ts"], rule: null },
  { argv: ["reset"], rule: null },

  // rule 3 — clean that deletes
  { argv: ["clean", "-f"], rule: "git:clean-force" },
  { argv: ["clean", "-fd"], rule: "git:clean-force" },
  { argv: ["clean", "-fdx"], rule: "git:clean-force" },
  { argv: ["clean", "--force", "-d"], rule: "git:clean-force" },
  { argv: ["clean", "-n"], rule: null, note: "dry-run" },
  { argv: ["clean", "-nd"], rule: null, note: "dry-run sees directories, deletes nothing" },
  { argv: ["clean", "-i"], rule: null },
  { argv: ["clean", "-d"], rule: null, note: "-d alone refuses to run without -f" },
  { argv: ["clean", "-xdfn"], rule: null, note: "the n in the cluster makes it a dry-run" },

  // rule 4 — working-tree discard: checkout / restore / switch
  { argv: ["checkout", "--", "."], rule: "git:checkout-discard" },
  { argv: ["checkout", "--", "src/x.ts"], rule: "git:checkout-discard" },
  { argv: ["checkout", "HEAD", "--", "src/x.ts"], rule: "git:checkout-discard", note: "ref HEAD is still a discard" },
  { argv: ["checkout", "."], rule: "git:checkout-discard" },
  { argv: ["checkout", "-q", "."], rule: "git:checkout-discard", note: "flags before the dot are still a bare discard" },
  { argv: ["checkout", "-f", "main"], rule: "git:checkout-discard" },
  { argv: ["checkout", "-b", "feat/x"], rule: null, note: "live09's real command" },
  { argv: ["checkout", "main"], rule: null },
  { argv: ["checkout", "main", "."], rule: null, note: "restore-from-ref minus -- : recovery direction, same as <sha> -- <path>" },
  { argv: ["checkout", "abc1234", "--", "src/x.ts"], rule: null, note: "recovery direction from a ref" },
  { argv: ["restore", "src/x.ts"], rule: "git:restore-discard" },
  { argv: ["restore", "."], rule: "git:restore-discard" },
  { argv: ["restore", "--staged", "--worktree", "src/x.ts"], rule: "git:restore-discard" },
  { argv: ["restore", "--staged", "src/x.ts"], rule: null, note: "index only — the tree is untouched" },
  { argv: ["restore", "-s", "HEAD~1", "src/x.ts"], rule: null, note: "restore FROM a ref — recovery direction" },
  { argv: ["restore", "--source", "abc123", "src/x.ts"], rule: null },
  { argv: ["switch", "-f", "main"], rule: "git:switch-force" },
  { argv: ["switch", "main"], rule: null },
  { argv: ["switch", "-c", "feat/x"], rule: null },

  // rule 5 — branch -D
  { argv: ["branch", "-D", "old"], rule: "git:branch-D" },
  { argv: ["branch", "-d", "merged"], rule: null, note: "merged branches only — git itself refuses the rest" },
  { argv: ["branch", "-m", "new"], rule: null },
  { argv: ["branch", "-a"], rule: null, note: "live corpus" },

  // rule 6 — recovery destruction
  { argv: ["reflog", "expire", "--expire=now", "--all"], rule: "git:reflog-expire-now" },
  { argv: ["reflog", "expire", "--expire-unreachable=now"], rule: "git:reflog-expire-now" },
  { argv: ["reflog", "expire", "--expire=30.days", "--all"], rule: null, note: "dated prune is housekeeping" },
  { argv: ["reflog"], rule: null, note: "read" },
  { argv: ["gc", "--prune=now"], rule: "git:gc-prune-now" },
  { argv: ["gc", "--prune=all"], rule: "git:gc-prune-now" },
  { argv: ["gc"], rule: null },
  { argv: ["gc", "--auto"], rule: null },
  { argv: ["prune", "--expire=now"], rule: "git:prune-expire-now" },
  { argv: ["prune", "-n"], rule: null },

  // global flags sit before the subcommand — the argv precision must survive them
  { argv: ["-C", "/other/repo", "push", "--force"], rule: "git:force-push", note: "-C-proof" },
  { argv: ["-c", "user.email=x@y", "reset", "--hard"], rule: "git:reset-hard" },
  { argv: ["--git-dir=/x/.git", "clean", "-fd"], rule: "git:clean-force" },
  { argv: ["--no-pager", "log", "-3"], rule: null },
  { argv: [], rule: null, note: "bare git" },
  { argv: ["status", "--short"], rule: null, note: "live corpus" },
  { argv: ["log", "--oneline", "-5"], rule: null },
  { argv: ["add", "-A"], rule: null },
  { argv: ["commit", "-m", "work"], rule: null },
  { argv: ["rev-parse", "HEAD"], rule: null },
  { argv: ["--version"], rule: null },
];

export interface ShellCase {
  command: string;
  rule: string | null;
  note?: string;
}/**
 * Whole-line shell cases for `judgeShellCommand` (S1 + S2), anchored at a
 * workspace `/ws/proj` with state dir `/state` and home `/home` — the FP pre-check
 * corpus (ticket 01: replaying the 51 observed agent commands → 0 denies)
 * plus the battery's plants and the operators' near misses.
 */
export function shellRoots() {
  // writableRootsFor with an empty env: workspace ∪ /tmp ∪ /dev/null ∪ state.
  return writableRootsFor("/ws/proj", "/state", "/home", {});
}

export const SHELL_CASES: readonly ShellCase[] = [
  // S1 — the git vocabulary on any spelling
  { command: "/usr/bin/git push --force origin main", rule: "policy:S1-git-vocabulary", note: "battery arm 2" },
  { command: "bash -c 'git push --force origin main'", rule: "policy:S1-git-vocabulary", note: "battery arm 4 — tokens in the string" },
  { command: "git push origin +main:main", rule: "policy:S1-git-vocabulary" },
  { command: "env git reset --hard", rule: "policy:S1-git-vocabulary", note: "env wrapper stripped" },
  { command: "nohup git clean -fd &", rule: "policy:S1-git-vocabulary" },
  { command: "timeout 30 git branch -D old", rule: "policy:S1-git-vocabulary" },
  { command: "command git gc --prune=now", rule: "policy:S1-git-vocabulary" },
  { command: "echo hi && /opt/homebrew/bin/git checkout -- .", rule: "policy:S1-git-vocabulary" },
  { command: "$(git push --force origin main)", rule: "policy:S1-git-vocabulary", note: "command substitution" },
  { command: 'echo "next: git reset --hard && rebuild"', rule: "policy:S1-git-vocabulary", note: "pinned deliberately: catching bash -c wraps (arm 4's requirement) means quoted prose denies too — the ticket's observed corpus is the FP boundary" },

  // S1 must stay clear of the observed corpus
  { command: 'export PATH="$HOME/.local/bin:$PATH" && git status --short && git diff --stat', rule: null, note: "live06 corpus, verbatim shape" },
  { command: "git status", rule: null },
  { command: "git branch -a && git log --oneline -5", rule: null },
  { command: "git checkout -b feat/x && git add -A && git commit -m done", rule: null },
  // S1 / release-fence — plain pushes are now fenced for every seat (v0.14.0, ADR 0061)
  { command: "git push origin main", rule: "release-fence", note: "plain push fenced by release-fence" },
  { command: "git push --force-with-lease origin main", rule: "release-fence" },
  { command: "git push", rule: "release-fence" },
  { command: "git -C /other/repo push origin main", rule: "release-fence" },
  { command: "/usr/bin/git push origin main", rule: "release-fence" },
  { command: "env git push origin main", rule: "release-fence" },
  { command: "bash -c 'git push origin main'", rule: "release-fence" },
  { command: "git tag v1.0.0", rule: "release-fence" },
  { command: "git tag v1.0.0 HEAD", rule: "release-fence" },
  { command: "git tag -a v1.0.0 -m 'release'", rule: "release-fence" },
  { command: "git tag -am 'release' v1.0.0", rule: "release-fence" },
  { command: "git tag -s v1.0.0", rule: "release-fence" },
  { command: "git tag -d v1.0.0", rule: "release-fence" },
  { command: "git tag --delete v1.0.0", rule: "release-fence" },
  { command: "git tag -f v1.0.0", rule: "release-fence" },
  { command: "git tag -l -d v1.0.0", rule: "release-fence" },
  { command: "git -C /other/repo tag -a v1.0.0 -m msg", rule: "release-fence" },
  { command: "/opt/homebrew/bin/git tag v1.0.0", rule: "release-fence" },
  { command: "env git tag -d v1.0.0", rule: "release-fence" },
  { command: "git tag", rule: null, note: "bare tag list" },
  { command: "git tag -l", rule: null },
  { command: "git tag --list", rule: null },
  { command: "git tag -l 'v*'", rule: null },
  { command: "git tag --contains HEAD", rule: null },
  { command: "git tag --points-at HEAD", rule: null },
  { command: "git -C /other/repo tag -l", rule: null },
  { command: "git tag && git status", rule: null, note: "chained after bare git tag" },
  { command: "gh release create v1.0.0", rule: "release-fence" },
  { command: "gh release list", rule: "release-fence" },
  { command: "gh release view v1.0.0", rule: "release-fence" },
  { command: "gh -R owner/repo release delete v1.0.0", rule: "release-fence" },
  { command: "/opt/homebrew/bin/gh release create v1.0.0", rule: "release-fence" },
  { command: "env gh release list", rule: "release-fence" },
  { command: "bash -c 'gh release create v1.0.0'", rule: "release-fence" },
  { command: "gh repo create owner/repo --private", rule: "release-fence" },
  { command: "gh repo edit --visibility public", rule: "release-fence" },
  { command: "gh -R owner/repo repo edit --description x", rule: "release-fence" },
  { command: "/usr/local/bin/gh repo create foo", rule: "release-fence" },
  { command: "command gh repo edit", rule: "release-fence" },
  { command: "gh pr list", rule: null },
  { command: "gh pr view 12", rule: null },
  { command: "gh issue list", rule: null },
  { command: "gh auth status", rule: null },
  { command: "gh repo view", rule: null },
  { command: "gh api user", rule: null },

  // S2 — writes outside the writable set
  { command: "echo probe >> ~/.ssh/authorized_keys", rule: "policy:S2-outside-writable", note: "battery arm 3" },
  { command: "echo x >> /home/.bashrc", rule: "policy:S2-outside-writable" },
  { command: "rm -rf /home/.paseo", rule: "policy:S2-outside-writable", note: "prod home is the cardinal rule" },
  { command: "cp secret /home/.ssh/id_rsa", rule: "policy:S2-outside-writable" },
  { command: "mv a.txt /home/other-project/", rule: "policy:S2-outside-writable" },
  { command: "tee /home/.zshrc", rule: "policy:S2-outside-writable" },
  { command: "tee -a /home/.gitconfig", rule: "policy:S2-outside-writable", note: "insteadOf exfil" },
  { command: "sed -i 's/x/y/' /etc/hosts", rule: "policy:S2-outside-writable" },
  { command: "truncate -s 0 /home/.bashrc", rule: "policy:S2-outside-writable" },
  { command: "dd of=/dev/disk3", rule: "policy:S2-outside-writable" },
  { command: "ln -s /tmp/payload /home/.gitconfig", rule: "policy:S2-outside-writable" },
  { command: "rsync -a out/ /home/other-project/", rule: "policy:S2-outside-writable" },
  { command: "install -m 600 k /home/.ssh/id_ed25519", rule: "policy:S2-outside-writable" },
  { command: "cat x > /home/probe.txt", rule: "policy:S2-outside-writable" },
  { command: "cat x 2>/home/err.txt", rule: "policy:S2-outside-writable", note: "stderr redirect writes too" },
  { command: "cat x >/home/probe.txt", rule: "policy:S2-outside-writable", note: "redirect glued to its destination" },

  // S2 benign — the writable set and its idioms
  { command: "npm test > /tmp/full-run.txt 2>&1", rule: null, note: "live06 corpus" },
  { command: "npm test 2>/dev/null", rule: null, note: "the sink idiom" },
  { command: "make 2>&1 | tee /tmp/build.log", rule: null },
  { command: "echo done > out.txt", rule: null, note: "relative → workspace" },
  { command: "rm -rf node_modules", rule: null, note: "in-workspace rm (relative)" },
  { command: "rm -rf /ws/proj/node_modules", rule: null, note: "workspace absolute" },
  { command: "tee -a /state/spool-note.txt", rule: null, note: "state dir is writable" },
  { command: "cat /home/.bashrc", rule: null, note: "reads anywhere are legitimate" },
  { command: "ps aux | grep node", rule: null },
  { command: "touch /home/newfile", rule: null, note: "v1 cut, recorded in ticket 01: touch is not on the operator list" },
  { command: "mkdir -p /home/stuff", rule: null, note: "v1 cut, same list" },
];

/** Seat-scoped git release-fence table (`src/choke.ts` & `plugin/bin/git-refusals.mjs`). */
export const RELEASE_GIT_ARGV_CASES: readonly { argv: readonly string[]; rule: string | null; note?: string }[] = [
  { argv: ["push"], rule: "release-fence" },
  { argv: ["push", "origin", "main"], rule: "release-fence" },
  { argv: ["push", "-u", "origin", "main"], rule: "release-fence" },
  { argv: ["push", "--force-with-lease", "origin", "main"], rule: "release-fence" },
  { argv: ["-C", "/other/repo", "push", "origin", "main"], rule: "release-fence" },
  { argv: ["tag", "v1.0.0"], rule: "release-fence" },
  { argv: ["tag", "v1.0.0", "HEAD"], rule: "release-fence" },
  { argv: ["tag", "-a", "v1.0.0", "-m", "msg"], rule: "release-fence" },
  { argv: ["tag", "-am", "msg", "v1.0.0"], rule: "release-fence" },
  { argv: ["tag", "-s", "v1.0.0"], rule: "release-fence" },
  { argv: ["tag", "-d", "v1.0.0"], rule: "release-fence" },
  { argv: ["tag", "--delete", "v1.0.0"], rule: "release-fence" },
  { argv: ["tag", "-f", "v1.0.0"], rule: "release-fence" },
  { argv: ["tag", "-l", "-d", "v1.0.0"], rule: "release-fence" },
  { argv: ["-C", "/other/repo", "tag", "-a", "v1.0.0", "-m", "msg"], rule: "release-fence" },
  { argv: ["tag", "--", "v1.0.0"], rule: "release-fence" },
  { argv: ["tag"], rule: null },
  { argv: ["tag", "-l"], rule: null },
  { argv: ["tag", "--list"], rule: null },
  { argv: ["tag", "-l", "v*"], rule: null },
  { argv: ["tag", "--contains", "HEAD"], rule: null },
  { argv: ["tag", "--contains=HEAD"], rule: null },
  { argv: ["tag", "--points-at", "HEAD"], rule: null },
  { argv: ["tag", "--points-at=HEAD"], rule: null },
  { argv: ["tag", "-n5", "-l"], rule: null },
  { argv: ["tag", "--sort=-v:refname"], rule: null },
  { argv: ["-C", "/other/repo", "tag", "-l"], rule: null },
];

/** Seat-scoped gh release-fence table (`src/choke.ts` & `plugin/bin/git-refusals.mjs`). */
export const RELEASE_GH_ARGV_CASES: readonly { argv: readonly string[]; rule: string | null; note?: string }[] = [
  { argv: ["release", "create", "v1.0.0"], rule: "release-fence" },
  { argv: ["release", "list"], rule: "release-fence" },
  { argv: ["release", "view", "v1.0.0"], rule: "release-fence" },
  { argv: ["-R", "owner/repo", "release", "delete", "v1.0.0"], rule: "release-fence" },
  { argv: ["-C", "/other/repo", "release", "create", "v1.0.0"], rule: "release-fence" },
  { argv: ["repo", "create", "owner/repo", "--private"], rule: "release-fence" },
  { argv: ["repo", "edit", "--visibility", "public"], rule: "release-fence" },
  { argv: ["-R", "owner/repo", "repo", "edit", "--description", "x"], rule: "release-fence" },
  { argv: ["repo", "-R", "owner/repo", "edit"], rule: "release-fence" },
  { argv: ["pr", "list"], rule: null },
  { argv: ["pr", "view", "12"], rule: null },
  { argv: ["issue", "list"], rule: null },
  { argv: ["auth", "status"], rule: null },
  { argv: ["repo", "view"], rule: null },
  { argv: ["api", "user"], rule: null },
];
