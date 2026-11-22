[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/haidildariell/site-generator-speed-01-run-20261122-v1/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/haidildariell/site-generator-speed-01-run-20261122-v1/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

[make.fun bounty: Build a static site faster](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# site-generator-speed-01-run-20261122 — v1

A faster drop-in for makefun-site 1.0.0. `solve.js` exports `run(input)`,
which returns exactly the output tree makefun-site 1.0.0's `build` returns for
the same input, byte for byte. `main.ts` is the kit's driver, used as-is.

## How it is faster

Same answers, less work per answer:

- **Inline Markdown** scans literal runs and escapes them in bulk instead of
  escaping one character at a time, and skips the construct scan entirely for
  text holding no inline construct.
- **Markdown blocks** are lexed and rendered in one fused pass with
  hand-rolled line checks instead of a regex per line and an intermediate
  token list.
- **Slugs** take an ASCII fast path (NFKD is the identity there) and are
  memoised per build; titles, tag names and dates repeat heavily across a
  site.
- **Front matter** is parsed by hand instead of by a regex per line, and a
  source's body is kept as its split lines so it is never re-joined and
  re-split.
- **Templates** render into one shared output array instead of building an
  intermediate string per node, and partials whose render can only depend on
  `site`, `tags` and `recent` are rendered once per case and depth and
  reused. Which partials qualify is decided by a conservative free-name
  analysis over the parsed trees, and every include site is checked at run
  time for a loop frame that would shadow one of those names — so the cache
  can never change an answer.

Everything a case needs is created fresh inside `run()`: nothing is carried
from one case to the next.

## Verification

- Practice set (`kit/practice`): all 3 cases byte-identical to
  `practice/reference/expected.json` (3/3).
- Differential tests against the reference implementation: 12 adversarial
  cases (template shadowing, recursive includes, the 8-deep include cutoff,
  slug collisions, Unicode titles, every front-matter refusal, template
  parse errors, empty sites) and 900 randomised fuzz sites — all identical.
- Timing on this VM (whole `main.ts` process, single shot, median of 3):
  this entry ~865.000 µs vs the house baseline ~1.260.000 µs; `run()` CPU
  alone ~210.000–250.000 µs vs ~515.000–675.000 µs for the baseline.

## Files

- `solve.js` — the entry (ES module, dependency-free, no WASM/binary).
- `main.ts` — the kit driver, unchanged.
- `package.json` — `{"type": "module"}`, as in the baseline, so the driver
  loads as an ES module without a reparse.
- `README.md`, `LICENSE` (MIT), `.makefun/owner.json`.
