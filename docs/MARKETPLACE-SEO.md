# GitHub Marketplace listing: SEO and AEO research

Research for publishing the `hookbench check` GitHub Action, done on **2026-11-18**. Every listing field below is chosen from these findings. The general keyword research (search demand, ranking articles, GitHub repos) is in [RESEARCH.md](RESEARCH.md#keyword-and-landscape-research-for-seo-and-aeo); this file covers what is specific to the Marketplace.

## How the Marketplace finds and shows an Action

| Finding | Evidence |
| --- | --- |
| **Marketplace search matches only the Action's `name` and `description` from `action.yml`.** It does not match the README, the repository's About text or its topics. | Experiment on a live listing, [Pollen poppy.json Validator](https://github.com/marketplace/actions/pollen-poppy-json-validator). Searches for words from its `name` or `description` found it: `poppy` (1 of 1), `personal agent protocol` (1 of 1), `well-known` (1 of 8). Searches for words only in its README, About text or topics did not: `Sierra` (0 of 3), `agent-readiness` (0 of 23). |
| GitHub does not document how results are ranked. | [Publishing actions in GitHub Marketplace](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace) says nothing about ranking. A [2020 community analysis](https://gist.github.com/6220119/68647f0e54f064d39a58dfb0dbe0f907) found the order hard to explain. |
| The listing page title is `<name> · Actions · GitHub Marketplace · GitHub`, and the URL slug is the name, slugified. | The live listings fetched for this research. |
| The listing body is the repository README, so Google and answer engines read the README there. | The live listings fetched for this research. |
| The `name` must be unique, must not match a GitHub user or organization (unless that owner publishes it) or a Marketplace category, and must not be a GitHub feature name. | [GitHub docs](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace). **A GitHub organization called `Hookbench` exists**, so the bare name "Hookbench" is not allowed. |
| Categories: one **Primary Category**, plus an optional **Another Category**, chosen on the release form. | [GitHub docs](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace) |
| `branding.color` is one of white, black, yellow, blue, green, orange, red, purple, gray-dark. `branding.icon` is a Feather icon from GitHub's allowed list, which includes `radio`, `zap`, `bell`, `rss` and `activity`. | [Metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax) |
| No documented length limit, but search cards wrap descriptions at about 120 characters. | Observed in Marketplace search results, where line breaks appear about 117 to 120 characters in. |

**Consequence:** every keyword that should find the Action in Marketplace search has to be in `name` or `description`. The README carries the long tail for Google and answer engines.

## How the top Actions in Testing, Code quality and Security are titled

Fetched from the category pages (`/marketplace?type=actions&category=<slug>`) on 2026-11-18.

| Category | Name | Tagline |
| --- | --- | --- |
| Testing | Cypress.io | GitHub Action for running Cypress end-to-end and component tests |
| Testing | Test Reporter | Displays test results from popular testing frameworks directly in GitHub |
| Testing | Publish Test Results | Publishes JUnit, NUnit, XUnit, TRX, JSON test results on GitHub for .NET, Dart, Java, JS, Jest, Mocha, Python, Scala, … |
| Testing | Android Emulator Runner | Installs, configures and starts an Android Emulator directly on hardware-accelerated runners |
| Code quality | Super-Linter | Super-linter is a ready-to-run collection of linters and code analyzers, to help validate your source code |
| Code quality | MegaLinter | Combine all available linters to automatically validate your sources without configuration |
| Code quality | GraphQL Inspector | Tooling for GraphQL. Compare schemas, find breaking changes, find similar types |
| Code quality | Avoid AI Writing Gate | Fail CI when a prose file exceeds a deterministic finding-count threshold |
| Security | TruffleHog OSS | Find and verify leaked credentials in your source code |
| Security | Aqua Security Trivy | Scans container images for vulnerabilities with Trivy |
| Security | Harden-Runner | Harden-Runner provides runtime security for GitHub-hosted and self-hosted runners |

Patterns that rank and read well:

- **The name is a brand plus the plain noun for what the Action is**: Trivy, Test Reporter, GraphQL Inspector. Newer listings put the keyword first: MCProbe MCP Conformance Audit, MCP Conformance Gate.
- **The tagline starts with a verb**, names the object, then the outcome: "Find and verify leaked credentials in your source code". The gate pattern, "Fail CI when …", is common in Testing and Code quality.
- **Taglines are concrete and short.** The best fit in one card line pair (under about 120 characters) and name formats or tools (JUnit, GraphQL, Trivy) rather than adjectives.

## Search demand and competition

Google autocomplete and DuckDuckGo autocomplete show demand. Marketplace search counts show competition: the number of Actions that match.

| Term | Demand (autocomplete) | Marketplace Actions matching |
| --- | --- | --- |
| `mcp events` | yes: + openai, spec, claude, chatgpt, protocol | **0** |
| `sep-3415` | no suggestions (an exact id that answer engines quote) | **0** |
| `standard webhooks` | yes: + npm, specification | **0** |
| `webhook receiver` | yes: + test, tester | **0** |
| `mcp inspector` | strong: + tool, command, github, npx, cli, docker | **0** |
| `mock server` | `mcp mock server`, `mock mcp server for testing` | 5 |
| `mcp client` | `mcp client test tool`, `mcp test client` | 8 |
| `mcp test` / `test mcp` | `test mcp server` + online, locally, curl, postman | 27 |
| `mcp testing` | `mcp server testing tool`, `… framework` | 41 |
| `conformance` | `mcp conformance test`, `… framework` | 44 |
| `webhooks` | yes | 39 |
| `mcp ci` | weak (`mcp server ci cd`) | 64 |
| `chatgpt` | `mcp events chatgpt`, `chatgpt mcp events` | 71 |
| `mcp server` | strong | 181 |
| `webhook` | strong, including `webhook signature verification failed` | 215 |
| `mcp` | strong | 287 |

Gaps: `mcp events`, `sep-3415` and `standard webhooks` have demand and no competing Action. `mcp test`, `conformance` and `mcp client` are contested but small. `mcp server` and `webhook` are crowded, so they help only alongside the rare terms.

## Competing and adjacent Actions

All match `mcp conformance` or `mcp server test` in Marketplace search. Categories were read from each listing page.

| Action | Tagline | Categories |
| --- | --- | --- |
| [MCP Conformance Gate](https://github.com/marketplace/actions/mcp-conformance-gate) | Run the official MCP conformance suite in CI: PR report, scenario coverage, and a compliance badge for your MCP server | Testing |
| [MCP Conformance Tests](https://github.com/marketplace/actions/mcp-conformance-tests) (mcp-use) | Run MCP conformance tests against server implementations | Continuous integration, Testing |
| [MCProbe MCP Conformance Audit](https://github.com/marketplace/actions/mcprobe-mcp-conformance-audit) | Audit an MCP server: lint + fuzz its tools, score conformance 0-100, and fail the build below a threshold | Continuous integration, Code quality |
| [mcp-probe](https://github.com/marketplace/actions/mcp-probe) | Test an MCP server for protocol conformance, schema quality and robustness. Fails the build before your agents do | Continuous integration, Testing |
| [mcp-doctor](https://github.com/marketplace/actions/mcp-doctor) | Audit an MCP server implementation for spec conformance and quality issues, and gate PRs on the score | Continuous integration, Code quality |
| [MCP Rigor](https://github.com/marketplace/actions/mcp-rigor) | Test MCP servers deterministically in CI — natural-language tests, contract-drift gates, flaky detection, rich PR comments | Continuous integration, Testing |
| [MCP Protocol Compliance Test](https://github.com/marketplace/actions/mcp-protocol-compliance-test) | Test MCP servers in CI — protocol compliance, schema validation, tool smoke-testing | Code quality, Testing |
| [MCP Test Harness](https://github.com/marketplace/actions/mcp-test-harness) | Run MCP server tests and emit RFC-002 conformance level (badge-ready) for PR checks | (none shown) |
| [checkmcp](https://github.com/marketplace/actions/checkmcp) | Conformance checks for MCP servers. Your server tells every AI what it can do; this makes sure it does | (none shown) |
| [mcpsnoop](https://github.com/marketplace/actions/mcpsnoop) | Fail CI on what an MCP server actually did on the wire, and file every finding as a code scanning alert | Security, Code Scanning Ready |
| [Agent Security Harness](https://github.com/marketplace/actions/agent-security-harness) | Run protocol-level security tests against MCP/A2A/L402/x402 agent endpoints as a CI/CD gate | Security |

What they leave open:
- **None tests MCP Events.** Every one grades tools, schemas or the core protocol, and none mentions events, webhooks, SEP-3415 or ChatGPT's dialect.
- **They all lead with "MCP Conformance", "MCP server" or a brand.** A name that leads with MCP Events is unique, and so is the URL slug.
- **Categories cluster on Testing and Continuous integration.** That is also where people browse for test gates, so following the convention costs nothing and matches intent.

## Chosen keywords, field by field

| Field | Keywords | Why |
| --- | --- | --- |
| `name` | MCP Events, Conformance Test, SEP-3415 | The three highest-value terms. Two are uncontested in Marketplace search (`mcp events`, `sep-3415`). "Conformance test" matches the `mcp conformance test` demand. |
| `description` | MCP server, MCP Events, SEP-3415, ChatGPT, poll, push, signed, Standard Webhooks, CI | Only `name` and `description` are searchable, so the description carries the terms the name lacks. `standard webhooks` is uncontested; `chatgpt` pairs with `mcp events` in autocomplete. |
| README (listing body) | All of the above, plus test MCP Events in CI, MCP Events mock client, inspector, webhook signature verification, mock MCP server for testing | It is the page Google and answer engines index. |
| Release title and notes | MCP Events, SEP-3415, conformance test, GitHub Action, mock client | The release page is indexed and linked from the listing. |
| Repository About and topics | unchanged, plus GitHub Action and the `github-actions` topic | The Action is now part of what the repository is. |

## Name

**`MCP Events Conformance Test (SEP-3415)`**: 38 characters, slug `mcp-events-conformance-test-sep-3415`.

- **It leads with the keywords:** what it is for (MCP Events), what it does (conformance test), and the exact spec id (SEP-3415).
- **It is unique.** On 2026-11-18, `/marketplace/actions/mcp-events-conformance-test-sep-3415` returned 404, and Marketplace searches for `MCP Events Conformance Test` and `Events Conformance` returned 0 Actions. It matches no GitHub account or category name.
- **It lands in good places.** The page title becomes "MCP Events Conformance Test (SEP-3415) · Actions · GitHub Marketplace", and the spec id sits in both the URL and the title, where answer engines pick up exact ids.
- **The brand stays out of the name**, which keeps it keyword-led. The repository link (`NHTanvir/hookbench`) and the README carry the name Hookbench.

## Description (tagline): three options

| # | Option | Length |
| --- | --- | --- |
| 1 | Fail CI when your MCP server breaks MCP Events (SEP-3415): poll, push and signed webhooks, with a fix for every failure | 119 |
| 2 | Test your MCP server's events before ChatGPT does: SEP-3415 and ChatGPT checks for poll, push and signed Standard Webhooks | 122 |
| 3 | Fail CI when your MCP server breaks MCP Events: SEP-3415 and ChatGPT checks for poll, push and signed Standard Webhooks | 119 |

Evaluation against the findings:

- **Option 1** has the clearest benefit and the gate pattern that top Testing and Code quality Actions use. But it spends characters repeating "SEP-3415", already in the name, and adds neither `chatgpt` nor `standard webhooks`, the two extra terms with demand and no competition.
- **Option 2** carries both extra terms, but it opens with a hook instead of a plain verb and object, and repeats "Test" from the name. The benefit (catching problems before your real consumer does) is implied, not stated.
- **Option 3** keeps option 1's benefit-led opening and adds option 2's unique terms. Every word it contributes is one the name lacks and research shows is searched or uncontested: MCP server, ChatGPT, poll, push, signed, Standard Webhooks. It fits in one card line pair (119 characters) and is accurate: the Action has a `chatgpt` profile and verifies Standard Webhooks signatures.

**Pick: option 3.** The "fix for every failure" promise moves to the first line of the README, which the listing shows directly under the tagline.

## Categories

- **Primary: Testing.** The intent behind `test mcp server`, `mcp conformance test` and `mcp server testing tool` is testing. It is also the category of the closest competitors and of pollen.
- **Another: Continuous integration.** The Action is a CI gate (exit 1 on a MUST failure, a step summary report), and Testing plus Continuous integration is the most common pairing among the MCP conformance Actions above.
- **Considered and not chosen:**
  - **Security.** Webhook signatures and SSRF are a slice of what the Action checks, not its purpose, and the listing should stay accurate.
  - **AI Assisted.** The check is deterministic and uses no LLM.

## Branding

- **Icon: `radio`.** A broadcast signal, for events pushed to subscribers. It is in GitHub's allowed list and not used by the MCP Actions above.
- **Color: `purple`.** It matches the README's "MCP Events: SEP-3415" badge and stands apart from the green and blue many testing Actions use.

## Release title and notes

- **Title:** `v0.1.0: MCP Events (SEP-3415) conformance test, mock client and inspector`
- **Notes:**
  - lead with the same one-sentence answer as the README
  - then the copy-paste workflow, what is checked, the ChatGPT profile, and verified facts (test count, Node versions)
  - link the primary spec sources

## Sources

- [Publishing actions in GitHub Marketplace](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace)
- [Metadata syntax for GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax)
- [GitHub Marketplace: Actions in Testing](https://github.com/marketplace?type=actions&category=testing), [Code quality](https://github.com/marketplace?type=actions&category=code-quality), [Security](https://github.com/marketplace?type=actions&category=security)
- Marketplace search: [`mcp conformance`](https://github.com/marketplace?type=actions&query=mcp+conformance), [`mcp server test`](https://github.com/marketplace?type=actions&query=mcp+server+test), [`mcp events`](https://github.com/marketplace?type=actions&query=mcp+events), [`sep-3415`](https://github.com/marketplace?type=actions&query=sep-3415)
- [GitHub Actions ranking analysis (2020)](https://gist.github.com/6220119/68647f0e54f064d39a58dfb0dbe0f907)
- [Official MCP conformance suite and Action](https://github.com/modelcontextprotocol/conformance)
- Autocomplete data and the wider landscape: [RESEARCH.md](RESEARCH.md#keyword-and-landscape-research-for-seo-and-aeo)
