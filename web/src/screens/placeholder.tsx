/**
 * The six not-yet-built screens (T-03+): titled placeholders, honest about
 * their wave — no mock content, no fabricated telemetry, no seat-start
 * controls (ADR 0017). The title renders from the route alone so a reload
 * keeps the screen even while the first snapshot is still in flight; the
 * scope line lands when the snapshot does.
 */
import type { FactoryView } from "../../../plugin/shared/view.ts";
import type { Screen } from "../router.ts";

export interface PlaceholderScreenProps {
  screen: Screen;
  view: FactoryView | null;
}

export function PlaceholderScreen({ screen, view }: PlaceholderScreenProps) {
  const scope = view === null ? null : view.project === null ? "All projects" : (view.project.name ?? view.project.slug);
  return (
    <section className="console-placeholder" aria-labelledby="placeholder-heading">
      <h1 id="placeholder-heading">{screen.heading}</h1>
      <p>
        This screen arrives in a later build wave (ADR 0051 §7).
        {scope === null ? "" : (
          <>
            {" "}The live snapshot is connected — scope: <strong>{scope}</strong>.
          </>
        )}
      </p>
    </section>
  );
}
