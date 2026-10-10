/**
 * Judge–human agreement (plan section 8.2): raw agreement and Cohen's kappa, which corrects
 * agreement for what two raters would reach by chance given their label frequencies.
 */

export interface Agreement {
  readonly n: number;
  /** Share of items where both raters gave the same label. */
  readonly agreement: number;
  /** Cohen's kappa; null when undefined (both raters used one and the same label throughout). */
  readonly kappa: number | null;
}

export function cohensKappa<Label extends string | number>(
  pairs: readonly (readonly [Label, Label])[],
): Agreement {
  const n = pairs.length;
  if (n === 0) return { n: 0, agreement: 0, kappa: null };
  const observed = pairs.filter(([a, b]) => a === b).length / n;
  const labels = new Set<Label>(pairs.flatMap(([a, b]) => [a, b]));
  let expected = 0;
  for (const label of labels) {
    const first = pairs.filter(([a]) => a === label).length / n;
    const second = pairs.filter(([, b]) => b === label).length / n;
    expected += first * second;
  }
  if (expected >= 1) return { n, agreement: observed, kappa: null };
  return { n, agreement: observed, kappa: (observed - expected) / (1 - expected) };
}
