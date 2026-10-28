/** Additive execution identity; this module has no configuration or runtime IO. */
export const SPECIALIST_ROLES = ["pm", "ux", "architect", "dev", "qa"] as const;
export type ScrumRoleName = (typeof SPECIALIST_ROLES)[number];
export interface ArtifactRef {
  path: string;
  commit: string;
  sha256: string;
}
export interface ScrumTaskBinding {
  mode: "scrum";
  runId: string;
  role: ScrumRoleName;
  policyRevision: string;
  configRevision: number;
  artifactRefs: ArtifactRef[];
}
export function safeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) &&
    value !== ".."
  );
}
export function safePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((p) => p !== "" && p !== "." && p !== "..")
  );
}
export function artifactRefIsValid(value: unknown): value is ArtifactRef {
  const v = value as ArtifactRef | null;
  return (
    !!v &&
    safePath(v.path) &&
    /^[a-f0-9]{40}$/.test(v.commit) &&
    /^[a-f0-9]{64}$/.test(v.sha256)
  );
}
export function scrumBindingIsValid(value: unknown): value is ScrumTaskBinding {
  const v = value as ScrumTaskBinding | null;
  return (
    !!v &&
    v.mode === "scrum" &&
    safeId(v.runId) &&
    SPECIALIST_ROLES.includes(v.role) &&
    typeof v.policyRevision === "string" &&
    v.policyRevision.length > 0 &&
    Number.isSafeInteger(v.configRevision) &&
    v.configRevision >= 0 &&
    Array.isArray(v.artifactRefs) &&
    v.artifactRefs.every(artifactRefIsValid)
  );
}
