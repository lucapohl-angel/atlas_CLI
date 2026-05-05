# Platform binary packages

These packages each contain one self-contained Atlas binary produced by
`bun build --compile`. They are published as `optionalDependencies` of the
top-level `atlas-os` package; npm/pnpm/bun/yarn install only the one
matching the user's `process.platform` and `process.arch`.

Do **not** install or import these packages directly.

The launcher in `atlas-os` (`bin/atlas-launcher.mjs`) resolves the correct
sibling package at runtime and execs the binary it ships.

Built and published from CI by `.github/workflows/release.yml`.
