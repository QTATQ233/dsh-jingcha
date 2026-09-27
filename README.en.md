# Jingcha · dsh-jingcha

[![CI](https://github.com/you233/dsh-jingcha/actions/workflows/ci.yml/badge.svg)](https://github.com/you233/dsh-jingcha/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blue.svg)](https://github.com/topics/dsh-plugin)
[![model tokens](https://img.shields.io/badge/model%20tokens-0-brightgreen.svg)](#zero-model-tokens)

> A **runtime supervisor for DeepSeek Harness (DSH)**: it tells you whether a tool call is running normally,
> stalled, or misbehaving — and lets you **force-stop a single call** (nested sub-calls included) from a small
> traffic-light widget in the corner. **Zero model tokens by default.**

|  |  |
|---|---|
| ![light](docs/assets/panel-light.png) | ![dark](docs/assets/panel-dark.png) |
| light theme | dark theme (capsule, panel and palette share one colour scheme) |

## Why

| Problem | Without it | With it |
|---|---|---|
| A tool call goes quiet | The UI just says "running" — slow, dead, or waiting for your approval? | Snapshot + event stream give a **verdict with reasons** (slow / hanging / stuck / silent / awaiting approval / error storm) |
| You want to stop one runaway call | You can only cancel the whole turn | **Force-stop by callId**, or "stop stuck calls" / "stop all turns" (with confirmation) |
| You need a post-mortem | Nothing recorded | One event per call (tool, argument preview, duration, result, error class) in events.jsonl |
| You don't want plugin tokens | Registering a tool costs context | **toolEnabled: false** by default — the model never sees it, **0 tokens** |

## Features

- **Observation** — read-only hooks on tools/pre-execute, tools/execute, tools/result;
- **Verdicts** — slow / hanging / stuck / silent / awaiting-approval / error storm / plugin self-error;
- **Force stop** — fuses an AbortController of its own (upstream cancellation semantics untouched) and registers it
  already in pre-execute, so **nested sub-calls** can be stopped too; failures come back with a human-readable reason;
- **Widget** — draggable (position remembered), colour-graded by call duration, anomaly popups, hover-to-expand
  truncated text (flicker-free), five-corner reset, unified light/dark palette, hide-and-find-back, Ctrl+Shift+J;
- **HTTP API** — status / kill / stop / settings, loopback-only, Host allow-list, cross-site rejection, POST+JSON for mutations;
- **Persistence** — atomic status.json snapshot + rotating events.jsonl (8 MB rotation).

## Install

```powershell
dsh plugin --profile web add github:you233/dsh-jingcha
# restart dsh, then:
node test/verify.mjs          # 107 checks
node test/verify-client.mjs   #  90 checks (widget, DOM stubs)
```

A junction-based installer (tools/install.ps1) with automatic profile backup is included as an alternative.
See [docs/SHARING.md](docs/SHARING.md).

## Judgement rules (defaults)

| Verdict | Trigger | Suggested action |
|---|---|---|
| slow | a call runs longer than 30s (slowCallMs) | check whether it is a legitimately long task |
| hanging | in-flight longer than 2min (hangCallMs) | watch it, maybe stop it |
| **stuck** | longer than 5min (stuckCallMs) **and** no progress (progressEveryMs) | press "stop stuck calls" |
| silent | an agent is running but nothing streamed for 90s (silenceMs) | look at the model side |
| awaiting approval | pre-execute blocked on approval for 20s (approvalWarnMs) | approve it — do not mistake it for a hang |
| error storm | 3 consecutive failures (errorStormCount) | stop and read the error classes |

## Configuration (cordis.patch.yml)

dataDir · displayName · toolEnabled · slowCallMs / hangCallMs / stuckCallMs · silenceMs · approvalWarnMs ·
autoKillAfterMs · previewArgs / redactPreviews · apiToken — every key is documented inline in
[cordis.patch.yml](cordis.patch.yml).

## Security

- Loopback only, Host allow-list (DNS-rebinding safe), cross-site Origin/Sec-Fetch-Site rejected,
  mutations require POST + application/json, optional shared token (apiToken);
- No network access, no third-party dependencies, no dynamic code execution; the widget uses textContent only;
- events.jsonl / status.json contain truncated argument previews with secret-ish fragments redacted;
- Residual risk: loopback means "everyone on this machine" — set apiToken on multi-user boxes.

## Layout

```
lib/core.js    pure logic: verdicts, counters, state machine (zero deps, unit-testable)
lib/index.js   host wiring: tool pipeline, fused abort signal, HTTP routes, heartbeat
lib/sink.js    persistence: atomic status.json + appended, rotating events.jsonl
lib/client.js  browser widget (single-file bundle, no require)
```

## Docs

[docs/SHARING.md](docs/SHARING.md) · [docs/EXTENDING.md](docs/EXTENDING.md) · [docs/PUBLISHING.md](docs/PUBLISHING.md) ·
[lib/WIDGET-SPEC.md](lib/WIDGET-SPEC.md) · [CHANGELOG.md](CHANGELOG.md)

## License

MIT — see [LICENSE](LICENSE).
