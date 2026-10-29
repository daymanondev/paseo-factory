/** Legacy run journals retain their original track names. */
export type RunTrack = "quick" | "standard" | "enterprise" | "small" | "backend" | "ui";
export function trackKind(track: RunTrack): "small" | "backend" | "ui" {
  return track === "quick" ? "small" : track === "standard" || track === "enterprise" ? "ui" : track;
}
export function requiredRoles(track: RunTrack) {
  return trackKind(track) === "small" ? ["dev", "qa"] : trackKind(track) === "backend" ? ["pm", "architect", "dev", "qa"] : ["pm", "ux", "architect", "dev", "qa"];
}
export function validTrack(track: unknown): track is RunTrack {
  return ["quick", "standard", "enterprise", "small", "backend", "ui"].includes(String(track));
}
