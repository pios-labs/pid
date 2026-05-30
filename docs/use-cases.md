# What people use pid for

`pid` supervises [pi](https://pi.dev) agents that run in the background: it enforces per-service cost budgets, restarts them when they crash, quarantines the ones stuck in a failure loop, and routes any approval requests to one place. This page is about *when that's worth it* — the real jobs pid is good at, with a ready-to-run service file for each.

Every example here is a real `examples/services/*.yaml` in this repo, validated in CI. For a single annotated file that exercises (almost) every available field, see [`examples/services/kitchen-sink.yaml`](../examples/services/kitchen-sink.yaml).

## Why this matters now

Agentic tools spend tokens very differently from chat. An agent re-sends its growing context on every tool call, so a single task can cost dollars, not cents — and a stuck agent keeps paying. In 2026 this stopped being theoretical: press reporting describes enterprises where agentic coding bills outran expectations badly enough to force licence cuts and mid-year budget freezes ([Fortune](https://fortune.com/2026/05/22/microsoft-ai-cost-problem-tokens-agents/), [Tom's Hardware](https://www.tomshardware.com/tech-industry/artificial-intelligence/ai-costs-begin-to-bite-as-agents-may-increase-token-demand-by-24-times-says-goldman-sachs-report-uber-and-microsoft-among-companies-feeling-the-bite-of-tokenized-billing)). Gartner reported in March 2026 that only ~44% of organisations had adopted any AI financial guardrails.

There's now a healthy market of tools that give you **visibility** into agent spend. The harder part — widely acknowledged in the FinOps-for-AI writing — is **control**: a budget that stops the agent *before* the next call, not a dashboard that explains the overage afterwards ([Finout](https://www.finout.io/blog/finops-in-the-age-of-ai-a-cpos-guide-to-llm-workflows-rag-ai-agents-and-agentic-systems), [TrueFoundry](https://www.truefoundry.com/blog/the-agentic-token-explosion-in-ci-cd)). pid is a control tool, for agents you run yourself.

## The shape of a good pid job

pid earns its keep when a job is **unattended**, you're running **more than one** of them, and they **touch something real** — money, production systems, your main branch, customer-facing output. The more of those three a job has, the more pid is doing for you. (If it's one agent you're watching in a terminal, you don't need pid — see [When you don't need pid](#when-you-dont-need-pid).)

## Keep spend under control

The headline. A per-service daily/weekly budget, enforced in real time from pi's event stream, with `on_exceed: pause` to stop cleanly and auto-resume at the next window. This is the difference between "we found out at the end of the month" and "it stopped at $15."

`examples/services/bug-triage.yaml`:

```yaml
name: bug-triage
cwd: ~/work/myapp
prompt: |
  For each new issue labelled "bug": reproduce it, find the root cause, and
  open a DRAFT PR with a minimal failing test plus a proposed fix.
  Never push to main.

model:
  provider: anthropic
  id: claude-sonnet-4-6
  thinking: medium

trigger:
  type: cron
  schedule: "*/30 * * * *"

budget:
  daily_usd: 15.00
  weekly_usd: 60.00
  on_exceed: pause          # stop before the next LLM call; resume next window
  reset_tz: Europe/London

restart:
  policy: on-failure
  max_consecutive: 3

quarantine:
  same_failure_threshold: 3
  window_seconds: 600

gate:
  - bash:git-push
  - bash:gh-pr-merge
```

**Per-team budgets are just several of these under one daemon.** pid enforces each service's cap independently and sums them into a fleet total, so `pid status` showing five services with five budgets and today's spend per service *is* the FinOps view — no separate platform required.

## Bounded autonomy on big jobs

Large refactors and framework migrations are exactly the kind of thing you'd love to run overnight and exactly the kind of thing that's scary to leave unattended. Scope one worker to one package, cap its spend, quarantine it if it's still burning at the cap (a migration that can't converge is broken, not slow), and gate anything destructive. You review the draft PRs in the morning.

`examples/services/codemod-api-v2.yaml`:

```yaml
name: codemod-api-v2
cwd: ~/work/monorepo/services/billing
prompt: |
  Migrate this package from the v1 to the v2 client API per MIGRATION.md.
  Make the change, run THIS package's tests until green, open a DRAFT PR.
  Touch no other package. Never push to main.

model:
  provider: anthropic
  id: claude-opus-4-8
  thinking: high

trigger:
  type: cron
  schedule: "0 2 * * *"

budget:
  daily_usd: 25.00
  on_exceed: quarantine     # still burning at the cap = broken, not slow

gate:
  - bash:git-push
  - bash:rm
  - bash:git-reset
```

pid bounds the *cost and blast radius* — it does not vouch for the diff. Pair it with mandatory human review; that's the point of the draft-PR-only instruction and the `git-push` gate.

## Governed and audited changes

Two related jobs where the *approval gate* and the *audit trail* are the product, not the cost cap.

**Dependency updates a human actually signs off on.** Platforms increasingly auto-open AI-authored dependency-fix PRs, which is convenient — but AI dependency PRs tend to get waved through without scrutiny, and that's a recognised supply-chain risk ([GitHub](https://github.blog/changelog/2026-04-07-dependabot-alerts-are-now-assignable-to-ai-agents-for-remediation/), [Security Boulevard](https://securityboulevard.com/2026/04/renovate-dependabot-the-new-malware-delivery-system/)). Running it under pid forces a human gate and records every step.

`examples/services/governed-deps.yaml`:

```yaml
name: governed-deps
cwd: ~/work/myapp
prompt: |
  Find outdated or vulnerable dependencies. For each: read the release notes,
  apply the update, fix any resulting build/test breakage, and open a DRAFT PR
  explaining what changed and why it is safe.

trigger:
  type: cron
  schedule: "0 7 * * 1"

budget:
  daily_usd: 10.00
  on_exceed: pause

gate:
  - bash:git-push
  - bash:npm-publish

auto_approve:
  - bash:npm-install
  - bash:npm-test
```

**Auditable autonomy.** A scheduled, report-only agent whose gate blocks every write path. pid records every action, cost, and approval to the service's event log — an audit trail by construction, which matters as agent actions come under the same governance scrutiny as everything else in production ([IBM on the agent control plane](https://www.ibm.com/think/topics/agent-control-plane)).

`examples/services/soc2-evidence.yaml`:

```yaml
name: soc2-evidence
cwd: ~/work/infra
prompt: |
  Collect this week's SOC2 evidence: check IAM policies, S3 bucket settings,
  and CloudTrail config against controls.md. Write findings to
  evidence/<date>.md. Report only — change nothing.

trigger:
  type: cron
  schedule: "0 6 * * 1"

budget:
  weekly_usd: 8.00
  on_exceed: notify

gate:
  - bash:aws-iam-put
  - bash:aws-s3-put
  - bash:terraform-apply
```

## Resilient unattended automation

The case that makes crash-loop quarantine obvious. Anything pointed at the outside world — scrapers, synthetic monitors, browser automation — breaks constantly because the world changes underneath it. You want self-healing (let the agent fix the selector and retry), but you do *not* want infinite retries against a permanently-changed site quietly draining the budget. `quarantine` draws that line.

`examples/services/price-watch.yaml`:

```yaml
name: price-watch
cwd: ~/work/scrapers
prompt: |
  Run ./scrape.ts. If it fails because the target site changed, read the error,
  fix the selector, and retry. Append results to prices.jsonl.

trigger:
  type: cron
  schedule: "0 */6 * * *"

budget:
  daily_usd: 3.00
  on_exceed: pause

restart:
  policy: on-failure
  max_consecutive: 5

quarantine:
  same_failure_threshold: 4
  window_seconds: 1800
```

## Where pid fits

2026 turned "governing autonomous agents" into a real category — control planes, agent-management platforms, audit logging for agent actions ([IBM](https://www.ibm.com/think/topics/agent-control-plane), [The New Stack on Galileo's open-source Agent Control](https://thenewstack.io/galileo-agent-control-open-source/), [Cloud Security Alliance](https://cloudsecurityalliance.org/blog/2026/03/20/2026-securing-the-agentic-control-plane)). Most of those are enterprise platforms: cloud-hosted, Kubernetes-shaped, built for fleets of agents across an org.

pid is the **local-first** option. It's a single daemon on one machine that supervises the agents you already run, with no platform to adopt and nothing to route your traffic through — closer to `systemd` than to a cloud console. If you're an individual, a small team, or a homelab that takes its automation seriously, that's the point. If you need org-wide identity, multi-region orchestration, and a managed dashboard, one of the enterprise platforms is a better fit, and pid won't pretend otherwise.

## When you don't need pid

Honest scope — pid is overkill, or the wrong tool, when:

- **It's a single scheduled job with no budget or approval needs.** `cron` plus `pi --mode json "…"` is simpler. Use that.
- **It's one agent you're actively watching in a terminal.** You're already the supervisor; just run it (tmux is great for keeping it alive and observable).
- **It's a synchronous, high-QPS, customer-facing service.** That's a web service with autoscaling, not a supervised background agent. Wrong tool.

If you have *more than one* unattended agent that touches something you'd hate to get wrong, that's when pid starts paying for itself.

---

### Sources

- [AI's real cost problem (Fortune, May 2026)](https://fortune.com/2026/05/22/microsoft-ai-cost-problem-tokens-agents/)
- [AI costs begin to bite; agents may increase token demand 24× (Tom's Hardware)](https://www.tomshardware.com/tech-industry/artificial-intelligence/ai-costs-begin-to-bite-as-agents-may-increase-token-demand-by-24-times-says-goldman-sachs-report-uber-and-microsoft-among-companies-feeling-the-bite-of-tokenized-billing)
- [FinOps in the Age of AI (Finout)](https://www.finout.io/blog/finops-in-the-age-of-ai-a-cpos-guide-to-llm-workflows-rag-ai-agents-and-agentic-systems)
- [The agentic token explosion in CI/CD (TrueFoundry)](https://www.truefoundry.com/blog/the-agentic-token-explosion-in-ci-cd)
- [Dependabot alerts assignable to AI agents (GitHub Changelog)](https://github.blog/changelog/2026-04-07-dependabot-alerts-are-now-assignable-to-ai-agents-for-remediation/)
- [Renovate & Dependabot as a malware delivery vector (Security Boulevard)](https://securityboulevard.com/2026/04/renovate-dependabot-the-new-malware-delivery-system/)
- [What is an agent control plane? (IBM)](https://www.ibm.com/think/topics/agent-control-plane)
- [Galileo open-sources Agent Control (The New Stack)](https://thenewstack.io/galileo-agent-control-open-source/)
- [Securing the agentic control plane (Cloud Security Alliance)](https://cloudsecurityalliance.org/blog/2026/03/20/2026-securing-the-agentic-control-plane)
