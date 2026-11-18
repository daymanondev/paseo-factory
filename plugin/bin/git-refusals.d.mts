/**
 * The plain-JS mirror's declaration — see git-refusals.mjs for why it exists.
 * test/git-shim.test.ts runs both implementations over one shared case table.
 */
export declare function refuseGitArgv(argv: readonly string[]): { rule: string; reason: string } | undefined;
export declare function refuseReleaseGitArgv(argv: readonly string[]): { rule: string; reason: string } | undefined;
export declare function refuseReleaseGhArgv(argv: readonly string[]): { rule: string; reason: string } | undefined;
