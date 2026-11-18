# Contributing to Hookbench

Thanks for helping. Hookbench tests MCP Events implementations against
[SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415). The two most
useful contributions are:
- reports of real servers or clients it gets wrong
- rules for requirements it does not check yet

## Report a false positive or a missed problem

[Open an issue](https://github.com/NHTanvir/hookbench/issues/new) with:

- what you ran, for example `hookbench check <url> --format json`
- the output, or the JSON report
- the sentence of the SEP (or of OpenAI's guide, for `--profile chatgpt`) that says Hookbench is wrong

The spec is still a draft. If it is ambiguous, say so: it's fine to open an issue just to ask how a rule should read.

## Set up

You need Node.js 18 or newer.

```sh
git clone https://github.com/NHTanvir/hookbench.git
cd hookbench
npm ci
npm test                         # builds, then runs every test
node dist/cli.js demo --once     # the offline smoke test
```

The tests run fully offline against the bundled reference server, on random local ports.

## Add or change a conformance rule

Every rule has three parts, and a change should touch all three:

1. **The rule** in `src/check/rules.ts`: an id, a title, a level (`MUST`, `SHOULD` or `INTEROP`) and the link to the requirement it grades.
2. **The probe** in `src/check/runner.ts`: a fixed request with a fixed expectation. When the rule cannot be observed (no trigger, no credentials, no reachable callback), skip it and say why. Never guess.
3. **A fault** in `src/server/reference-server.ts` that breaks exactly that rule, plus a row in the `CASES` table in `tests/check.test.ts`.

The test suite fails if a rule has no fault that breaks it, or if a fault flags any rule but its own. That is how a red check against a real server can be trusted.

## Keep `dist/` in step

The GitHub Action and `npx github:NHTanvir/hookbench` run the committed `dist/`, so run `npm run build` and commit `dist/` with your change. CI fails when `dist/` is stale.

## Style

- TypeScript, strict, no runtime dependencies. Node built-ins only.
- Messages say what was wrong and what to do about it, in plain words.
- Event payloads are untrusted: the inspector renders them as text only.
- Conventional commit messages (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).

## Licence

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
