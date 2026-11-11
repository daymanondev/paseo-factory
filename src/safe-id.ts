/** A path-segment-safe identifier: shared by Project slugs, Open Design project ids and Scrum run ids. */
export function safeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) &&
    value !== ".."
  );
}
