/** Plain-JS mirror declarations; shared behavioral cases guard parity with core. */
export declare function scopeCoversFile(scope: readonly string[], file: string): boolean;
export declare function scopeRecoveryCommands(base: string, files: readonly string[]): string;
export declare function normalizeScopePath(path: string): string;
