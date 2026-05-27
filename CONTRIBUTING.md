# Contributing to pid

Thanks for your interest in `pid`. This project is in early development; expect rough edges and a moving target.

## Development setup

```bash
git clone https://github.com/pios-labs/pid
cd pid
npm install
npm run build
npm test
```

You'll need Node `>=22.19.0` and a working `pi` install on `$PATH` for the integration smoke test.

## Useful scripts

- `npm run dev` — run the daemon with hot reload via `tsx watch`
- `npm run check` — Biome (format + lint) and TypeScript type check
- `npm test` — run the test suite

## Conventions

- Tabs for indentation, double quotes, trailing commas (enforced by Biome)
- `npm run check` must pass before opening a PR
- Keep changes scoped; one logical change per PR
- New features need at least one test
- Update the spec in `docs/v0-spec.md` if you change protocol or behavior

## Reporting bugs

Use [GitHub issues](https://github.com/pios-labs/pid/issues). Include `pid version`, your OS, and a minimal reproduction.

## Pre-release

`pid` is pre-1.0. Behavior and protocol may change between minor versions until 1.0.
