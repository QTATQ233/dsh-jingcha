<div align="center">

<img src="docs/assets/logo.svg" alt="Jingcha logo" width="120" />

<h1>Jingcha · dsh-jingcha</h1>

<p><strong>A runtime supervisor for DeepSeek Harness — know whether a tool call is slow, stuck or broken, and stop the runaway one from a corner widget.</strong></p>

<p>
<a href="https://github.com/QTATQ233/dsh-jingcha/actions/workflows/ci.yml"><img src="https://github.com/QTATQ233/dsh-jingcha/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
<a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-blue.svg" alt="topic: dsh-plugin" /></a>
<img src="https://img.shields.io/badge/dependencies-0-brightgreen.svg" alt="0 dependencies" />
<img src="https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg" alt="node >= 18" />
<img src="https://img.shields.io/badge/model%20tokens-0-brightgreen.svg" alt="0 model tokens" />
<a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome" /></a>
<a href="https://github.com/QTATQ233/dsh-jingcha/stargazers"><img src="https://img.shields.io/github/stars/QTATQ233/dsh-jingcha?style=social" alt="stars" /></a>
</p>

<p>
<a href="README.md">中文</a> · <a href="README.en.md">English</a> · <a href="docs/">Docs</a> · <a href="CHANGELOG.md">Changelog</a>
</p>

<p><img src="docs/assets/demo.gif" alt="status capsule demo (stylised)" width="72%" /></p>

<p>
<img src="docs/assets/screenshot-light.png" alt="light theme" width="23%" />
<img src="docs/assets/screenshot-dark.png" alt="dark theme" width="23%" />
<img src="docs/assets/screenshot-panel-detail.png" alt="verdict and in-flight calls" width="23%" />
<img src="docs/assets/screenshot-capsule.png" alt="status capsule" width="23%" />
</p>

<p>💡 <strong>If this project helps you, a ⭐ is the greatest support.</strong></p>

</div>

---

## 📖 Contents

- [Why](#why)
- [What it looks like](#what-it-looks-like)
- [Quick start](#quick-start)
- [Features](#features)
- [Verdicts](#verdicts)
- [Configuration](#configuration)
- [Security](#security)
- [Zero model tokens](#zero-model-tokens)
- [Architecture and state machine](#architecture-and-state-machine)
- [API and schemas](#api-and-schemas)
- [Examples](#examples)
- [Glossary](#glossary)
- [Roadmap](#roadmap)
- [FAQ](#faq)
- [Docs](#docs)
- [Contributing](#contributing)
- [License](#license)

---

<a id="why"></a>
## 🎯 Why

You ask the model to run something; the UI says "running" and then says nothing for four minutes. Is it slow? Dead? Waiting for your approval? DeepSeek Harness gives you a spinner — Jingcha gives you an answer, plus a way out.

| Pain | Without Jingcha | With Jingcha |
|---|---|---|
| A call goes quiet | A spinner and a guess | A verdict with reasons: slow / hanging / stuck / silent / awaiting approval / error storm / memory leak |
| One runaway call | Cancel the whole turn — collateral damage included | Stop that single call by callId, "stop stuck calls", or "stop all turns" (confirmation required) |
| You want a post-mortem | Nothing recorded | One event per call — tool, argument preview, duration, result, error class — in events.jsonl |
| Plugin overhead | Registering a tool eats context on every request | Nothing is registered by default: the model never sees it, and it costs 0 tokens |

<a id="what-it-looks-like"></a>
## 🖼️ What it looks like

| Light | Dark |
|---|---|
| ![light](docs/assets/screenshot-light.png) | ![dark](docs/assets/screenshot-dark.png) |

| Panel detail | Status capsule |
|---|---|
| ![panel](docs/assets/screenshot-panel-detail.png) | ![capsule](docs/assets/screenshot-capsule.png) |

- **Capsule** — a status dot plus the verdict, or "pwsh 1m33s" while something runs. Drag it anywhere; the position is remembered.
- **Panel** — four collapsible sections: verdict (with event-loop lag and call counters), in-flight calls (each with a ⛔ force-stop button), recent alerts, settings.
- **Light colour** — derived client-side from call duration: green under the yellow threshold, yellow under the red one, red (with a breathing dot) beyond it.
- **One palette** — capsule, panel, palette and toast all derive from a single base colour, and the text colour follows the base, so dark mode never shows white-on-white.

<a id="quick-start"></a>
## 🚀 Quick start

```powershell
# Official plugin channel (restart dsh afterwards)
dsh plugin --profile web add github:QTATQ233/dsh-jingcha

# Self-tests: zero dependencies, dsh does not need to be running
node test/verify.mjs          # 121 checks
node test/verify-client.mjs   #  90 checks (widget, DOM stubs)
```

Prefer to skip pnpm? tools/install.ps1 creates a junction, edits the profile manifest, backs it up first and can roll the whole thing back. See [docs/SHARING.md](docs/SHARING.md) for install, uninstall and a pre-share safety checklist.

<a id="features"></a>
## ✨ Features

- **Observation** — read-only hooks on tools/pre-execute, tools/execute and tools/result; every monitoring path is wrapped in safe(), so an internal error can never damage the call it is watching.
- **Verdicts** — slow, hanging, stuck, silent (an agent is running but nothing is streaming), awaiting approval, error storm, memory-leak warning, and the plugin's own errors.
- **Force stop** — Jingcha fuses its own AbortController into exec.signal while leaving upstream cancellation semantics intact, and registers it already during pre-execute, so nested sub-calls (parent id plus a :ptc: suffix) can be stopped too. When it cannot stop something it says why — for example, it refuses to kill a parent call just because you aimed at a child.
- **Widget** — draggable with remembered position, colour-graded by duration, anomaly popups on the right, hover-to-expand truncated text (flicker-free), five-corner reset, unified light/dark palette, hide-and-find-back, Ctrl+Shift+J shortcut.
- **HTTP API** — status, kill, stop and settings endpoints; loopback only, Host allow-list, cross-site rejected, mutations require POST with JSON.
- **Persistence** — an atomically replaced status.json snapshot plus an appended events.jsonl that rotates at 8 MB.

<a id="verdicts"></a>
## 🧭 Verdicts (defaults)

| Verdict | Trigger | Suggested action |
|---|---|---|
| slow | a single call exceeds 30s (slowCallMs) | check whether it is a legitimately long task |
| hanging | in flight for more than 2min (hangCallMs) | keep an eye on it, maybe stop it |
| **stuck** | in flight for more than 5min (stuckCallMs) and no output in between | press "stop stuck calls" |
| no output | an agent is running with nothing streamed for 90s (silenceMs) | look at the model side |
| awaiting approval | pre-execute blocked on approval for 20s (approvalWarnMs) | approve it — do not read it as a hang |
| error storm | 3 consecutive failures on one tool (errorStormCount) | stop and read the error classes |
| memory leak warning | RSS rises for 5 consecutive heartbeats and grows more than 10% (memoryLeakWindow / memoryLeakGrowth) | confirm whether it is a real leak; raise the window or threshold when the workload legitimately grows |
| plugin error | Jingcha itself threw | file a bug — it is designed never to break tool calls |

<a id="configuration"></a>
## ⚙️ Configuration

Every key lives in [cordis.patch.yml](cordis.patch.yml) with inline comments, and the machine-readable shape is in [docs/config.schema.json](docs/config.schema.json):

dataDir · displayName · toolEnabled · slowCallMs / hangCallMs / stuckCallMs · silenceMs · lagWarnMs / lagStuckMs ·
approvalWarnMs · errorStormCount / errorStormWindowMs · emptyResultBytes · heartbeatMs / statusEveryMs ·
progressEveryMs / consoleProgressMs · maxLogBytes · autoKillAfterMs · memoryLeakWindow / memoryLeakGrowth ·
previewArgs / redactPreviews / redactPatterns · apiToken

<a id="security"></a>
## 🔒 Security

- All four endpoints share one guard: loopback only, the Host header must be 127.0.0.1 / localhost / ::1 (this is what stops DNS rebinding), cross-site Origin and Sec-Fetch-Site are rejected, mutations require POST with application/json (that is what stops an img tag from killing a call), and an optional shared token (apiToken) can be required.
- The plugin makes no network requests, pulls in no third-party code and evaluates nothing dynamically; the widget only ever assigns textContent, so there is no injection surface.
- status.json and events.jsonl contain truncated argument previews with secret-looking fragments redacted — skim them before sharing, or set previewArgs: false.
- Residual risk: loopback means "everyone on this machine". On a multi-user box, set apiToken.
- The observation data is sensitive by nature: events.jsonl / status.json hold **argument previews** (120 chars max, redacted by default). Skim them before sharing, or set previewArgs: false.
- Redaction deliberately over-masks (--password x, token=…, Bearer …, even -p 8080). Loosen it via redactPatterns if that bothers you.
- Two independent security reviews (runtime + toolchain) for 0.4.3 found no high-severity issues; fixes include redaction coverage, sample clamping, constant-time token comparison and fail-closed publish checks (see CHANGELOG).

More detail in [SECURITY.md](SECURITY.md).

<a id="zero-model-tokens"></a>
## 🪙 Zero model tokens

By default Jingcha registers no model-visible tool (extras.tool is null in status.json), and neither the event stream nor the widget is fed into the model context. Turn on toolEnabled only if you want to ask "where is it stuck?" from inside a session — that costs roughly 176 tokens per request for the tool description, plus about 0.5k tokens per query.

<a id="architecture-and-state-machine"></a>
## 🏗️ Architecture and state machine

**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** has two Mermaid diagrams — a component/data-flow chart and the verdict state machine — plus the severity and destination of every reason kind and the six design trade-offs behind them.

- Priority: stalled > erroring > degraded > busy / ok, so one stuck call is never buried under a pile of warnings.
- Force-stop works because Jingcha swaps exec.signal for its own fused AbortController during pre-execute and restores it when the call ends.
- Read-only first: monitoring failures are counted, never propagated.

<a id="api-and-schemas"></a>
## 🔌 API and schemas

| Artifact | File | Purpose |
|---|---|---|
| OpenAPI 3.1 | **[docs/openapi.yaml](docs/openapi.yaml)** | The full contract of the four endpoints: guard rules, error codes, every response field |
| Config JSON Schema | **[docs/config.schema.json](docs/config.schema.json)** | The 28 config fields with types, defaults, ranges and descriptions |

```http
GET  /api/jingcha/status      # verdict + in-flight calls + recent alerts (same source as status.json)
POST /api/jingcha/kill        # { "callId": "..." } or { "scope": "stalled|all" }
POST /api/jingcha/stop        # cancel every running turn
GET  /api/jingcha/settings    # read widget settings (plus defaults)
POST /api/jingcha/settings    # write them (field allow-list, values clamped, then persisted)
```

<a id="examples"></a>
## 🧪 Examples

Four zero-dependency scripts in [examples/](examples/), all runnable with node:

| Script | What it does |
|---|---|
| [01-read-status.mjs](examples/01-read-status.mjs) | prints the verdict from status.json; exits 1 when the state is not ok/busy, so it drops straight into cron or CI |
| [02-watch-http.mjs](examples/02-watch-http.mjs) | polls the HTTP endpoint and only prints when the verdict changes |
| [03-kill-runaway.mjs](examples/03-kill-runaway.mjs) | lists in-flight calls and stops a chosen (or the longest) one — dry-run unless you pass --yes |
| [04-custom-verdict.mjs](examples/04-custom-verdict.mjs) | drives lib/core.js directly to build a verdict, showing how little is needed to extend it |

<a id="glossary"></a>
## 📔 Glossary

Verdict, state, reason, finding, in-flight, stuck, silent, fused signal, nested sub-call, the ptc suffix and the rest are defined (Chinese and English side by side) in **[docs/GLOSSARY.md](docs/GLOSSARY.md)**.

<a id="roadmap"></a>
## 🗺️ Roadmap

**[ROADMAP.md](ROADMAP.md)** — 0.5 (composable rules, per-session filtering, post-stop forensics), 0.6 (i18n, config validation, optional metrics export), 1.0 (single settings contract, observable swallowed failures). Explicitly out of scope: mutating tool calls, telemetry by default, hard-killing in-process loops, and pushing observations into the model context by default.

<a id="faq"></a>
## ❓ FAQ

- **It will not stop.** A same-process loop that ignores exec.signal cannot be killed from outside — Jingcha can only abort the signal. Subprocesses such as pwsh really are terminated. For a nested call whose parent is still running, Jingcha refuses instead of killing the parent by mistake.
- **Can it break my tool calls?** Every monitoring path sits inside safe(); failures are swallowed and counted in pluginErrors and never touch the result.
- **How big does the data get?** events.jsonl rotates at 8 MB and keeps one previous file (about 16 MB total); status.json is always a single snapshot.
- **Do I have to restart?** Changes to host-side code need a dsh restart; the widget alone is picked up by refreshing the page.

<a id="docs"></a>
## 📚 Docs

| File | Content |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | data flow and verdict state machine (Mermaid) |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | terminology, Chinese and English |
| [docs/openapi.yaml](docs/openapi.yaml) | OpenAPI 3.1 contract for the HTTP endpoints |
| [docs/config.schema.json](docs/config.schema.json) | JSON Schema for the configuration |
| [docs/SHARING.md](docs/SHARING.md) | install for others, uninstall, pre-share checklist |
| [docs/EXTENDING.md](docs/EXTENDING.md) | the minimal edits behind the five common changes |
| [docs/PUBLISHING.md](docs/PUBLISHING.md) | maintainer release flow |
| [examples/](examples/) | four runnable, dependency-free examples |
| [lib/WIDGET-SPEC.md](lib/WIDGET-SPEC.md) | widget specification and acceptance list |
| [ROADMAP.md](ROADMAP.md) | where this is going, and what it will never do |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | community expectations |
| [CHANGELOG.md](CHANGELOG.md) | version history |

<a id="contributing"></a>
## 🤝 Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) lists three rules that keep this project safe to run (observe only, keep host and widget settings in sync, never rebuild interactive controls during a poll), the self-test commands, and a set of good-first-issue ideas. New contributors are welcome — issues and PRs both work.

<a id="license"></a>
## 📄 License

MIT — see [LICENSE](LICENSE). Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before participating.

---

<a id="star-history"></a>
## ⭐ Star history

<a href="https://star-history.com/#QTATQ233/dsh-jingcha&Date">
<img src="https://api.star-history.com/svg?repos=QTATQ233/dsh-jingcha&type=Date" alt="Star History Chart" width="70%" />
</a>

## 📣 Share

<a href="https://twitter.com/intent/tweet?text=Jingcha%20for%20DeepSeek%20Harness%3A%20runtime%20verdicts%20and%20force-stop%20for%20tool%20calls&url=https%3A%2F%2Fgithub.com%2FQTATQ233%2Fdsh-jingcha"><img src="https://img.shields.io/badge/share-X%2FTwitter-000000.svg" alt="Share on X" /></a>
<a href="https://t.me/share/url?url=https%3A%2F%2Fgithub.com%2FQTATQ233%2Fdsh-jingcha"><img src="https://img.shields.io/badge/share-Telegram-2CA5E0.svg" alt="Share on Telegram" /></a>
<a href="https://news.ycombinator.com/submitlink?u=https%3A%2F%2Fgithub.com%2FQTATQ233%2Fdsh-jingcha&t=Jingcha%20-%20runtime%20supervisor%20for%20DeepSeek%20Harness"><img src="https://img.shields.io/badge/share-Hacker%20News-FF6600.svg" alt="Share on Hacker News" /></a>
