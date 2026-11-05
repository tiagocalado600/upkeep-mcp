# 22. A quarter is compared against a baseline someone chose

Status: accepted (2026-11-06)

## Context

`0011` and `0018` keep one snapshot, replaced on every run, and `0018` says this
makes a quarter-over-quarter report possible. In ordinary use it does not:

- A weekly run replaces the snapshot, so the "quarterly" comparison covers a week.
- Fixed since `0.6.2` for narrower runs (`mergeRun`), but not for a full run in
  between, which is what someone doing this properly does every week.
- Ninety days refused most of the comparisons it was chosen for. 1 July to
  1 October is 92 days, and 1 October to 2 January is 93.
- The hosted instance has no durable comparison at all: it keeps nothing for a
  caller beyond the life of the process, and shares that memory between callers.

Both ADRs left a series of runs to be "asked for on its own". The owner asked,
after reading what the current behaviour does to the report this project's
tiebreaker is about.

## Decision

Not a series. **Comparison points someone chose**, in two forms that report through
the same `changes` field:

- **Named baselines**, in the history file. `saveBaselineAs: "2026-Q3"` keeps a run
  under a name, and `baselineName: "2026-Q3"` compares against it. Nothing is
  recorded under a name unless a caller asked for that name. The file still has one
  writer and the path the portfolio chose.
- **A snapshot the caller holds.** `includeSnapshot` returns the run as `snapshot`;
  next quarter `baselineSnapshot` passes it back. Nothing stays on the server, which
  is what makes this work unchanged on a hosted instance and on a local one, as the
  project's parity rule asks.

The changes field now separates `resolvedFindings`, `newFindings` and
`persistingFindings`, which is the paragraph a client actually reads.

## Consequences

- **A requested baseline that is missing is an unavailable comparison, never a
  fallback to the last run.** Asked for a quarter and given last week, the report
  would read as the comparison that was requested.
- **Named baselines are refused in memory**, including on a hosted instance. One
  process serves every caller there, and a name is something another caller could
  guess or overwrite.
- **A held snapshot carries a checksum.** The caller is often a model copying JSON,
  and an altered snapshot would produce a confident, wrong comparison. The checksum
  ignores key order, which JSON does not preserve. It detects accident, not forgery,
  and nothing here depends on more: a forged snapshot only misleads whoever forged it.
- **A held snapshot names the sites and travels through the model.** That is the cost
  of storing nothing, it is opt-in, and the field says so. Anyone not willing to pay
  it can use a history file.
- **Time limits.** The last run is compared for up to 100 days, which covers a
  quarter and a little lateness. A baseline lasts 400 days, enough to compare a
  quarter with the same one a year earlier, and is dropped at the next write after
  that. This is the time limit principle 5 asks of local state, read generously and
  on purpose: anything under a quarter would defeat the feature.
- **New checks look like new problems.** A snapshot records the version that took it,
  and a comparison across versions says that a new finding may only be new to this
  version. So a check should ship before the baseline it would be compared against,
  not after.
- **A file from `0.6.x` still reads.** Version 1 has no baselines, and the next write
  moves it to version 2.

## What was rejected

**A series of every run.** It answers no question a chosen baseline does not, and it
grows without anyone having decided to keep it.

**A file-only feature.** It would be simplest, and it would make the hosted instance
a worse product than the local one, which `README.md` promises it is not.

**Per-caller state on the hosted instance.** It needs an identity the instance does
not have, and a database this project will not run.
