/**
 * The Copy button's one helper (T-03) — gate commands, Claim SHAs, Reports,
 * and gate logs copy through the clipboard API with a textarea fallback for
 * non-secure contexts. A refusal (permissions, jsdom) resolves `false` — the
 * button's honest `Copied`/`Copy failed` feedback, never a throw.
 */
export type CopyText = (text: string) => Promise<boolean>;

export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard !== undefined && navigator.clipboard.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea path — some contexts deny the API per-call.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const landed = document.execCommand("copy");
    area.remove();
    return landed;
  } catch {
    return false;
  }
}
