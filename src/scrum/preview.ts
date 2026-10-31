import { safePath } from "./types.ts";
import { FactoryError } from "../errors.ts";
import { designDigest, gitBytes, verifyRefs } from "./artifacts.ts";
import type { ScrumRun } from "./run-journal.ts";
/** HTML is returned through scoped RPC; render only in an opaque sandbox, never surface DOM. */
export function renderPreview(
  root: string,
  run: ScrumRun,
  subpath = "mockups/index.html",
  options: { inlineAssets?: boolean } = {},
): { html: string; runId: string; revision: number; digest: string } {
  const design = run.design;
  if (!design || designDigest(design.refs) !== design.digest)
    throw new FactoryError("preview-unavailable", "no current accepted design");
  verifyRefs(root, design.refs, run.ownedPaths);
  if (!safePath(subpath) || subpath.startsWith("/")) throw new FactoryError("invalid-preview-path", subpath);
  const htmlRef = design.refs.find(
    (r) => r.path === `.scratch/${run.initiativeId}/${subpath.includes("/") ? subpath : "mockups/" + subpath}`,
  );
  if (!htmlRef)
    throw new FactoryError("preview-unavailable", "mockup artifact missing");
  let html = gitBytes(
    root,
    "show",
    `${htmlRef.commit}:${htmlRef.path}`,
  ).toString();
  if (options.inlineAssets === false) return { html, runId: run.runId, revision: design.revision, digest: design.digest };
  html = html.replace(
    /(?:src|href)\s*=\s*(["'])([^"']+)\1/gi,
    (match, quote: string, asset: string) => {
      if (asset.startsWith("#") || asset.startsWith("data:")) return match;
      const ref = design.refs.find(
        (r) => r.path === htmlRef.path.replace(/[^/]+$/, "") + asset.split(/[?#]/)[0],
      );
      if (!ref) throw new FactoryError("preview-missing-asset", asset);
      const bytes = gitBytes(root, "show", `${ref.commit}:${ref.path}`);
      const filename = asset.split(/[?#]/)[0];
      const mime = filename.endsWith(".css")
        ? "text/css"
        : filename.endsWith(".js")
          ? "text/javascript"
          : filename.endsWith(".svg")
            ? "image/svg+xml"
            : filename.endsWith(".png")
              ? "image/png"
              : filename.endsWith(".woff2")
                ? "font/woff2"
                : "application/octet-stream";
      return match.replace(
        asset,
        `data:${mime};base64,${bytes.toString("base64")}`,
      );
    },
  );
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; script-src 'unsafe-inline' data:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">`;
  html = html.replace(/<head\b[^>]*>/i, (match) => match + csp);
  if (!html.includes(csp))
    throw new FactoryError("preview-invalid-html", "head element required");
  return {
    html,
    runId: run.runId,
    revision: design.revision,
    digest: design.digest,
  };
}
