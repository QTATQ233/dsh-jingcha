<div align="center">

<img src="docs/assets/logo.svg" alt="Jingcha logo" width="120" />

<h1>Jingcha · dsh-jingcha</h1>

<p><strong>Runtime supervisor for DeepSeek Harness: live verdicts on tool calls, event-loop and error storms + force-stop a call + a traffic-light widget in the corner</strong></p>

<p>
<a href="https://github.com/you233/dsh-jingcha/actions/workflows/ci.yml"><img src="https://github.com/you233/dsh-jingcha/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
<a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-blue.svg" alt="topic: dsh-plugin" /></a>
<img src="https://img.shields.io/badge/dependencies-0-brightgreen.svg" alt="0 dependencies" />
<a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" /></a>
<img src="https://img.shields.io/badge/model%20tokens-0-brightgreen.svg" alt="0 model tokens" />
</p>

<p>
<a href="README.md">中文</a> · <a href="README.en.md">English</a> · <a href="docs/">Docs</a> · <a href="CHANGELOG.md">Changelog</a>
</p>

<p>
<img src="docs/assets/screenshot-light.png" alt="light theme" width="45%" />
<img src="docs/assets/screenshot-dark.png" alt="dark theme" width="45%" />
</p>

<p>💡 <strong>If this project helps you, a ⭐ is the greatest support!</strong></p>

</div>

---

## 📖 Contents

- [Why](#why)
- [Install](#install)
- [Features](#features)
- [Verdicts](#verdicts)
- [Configuration](#configuration)
- [Security](#security)
- [Zero model tokens](#zero-model-tokens)
- [How it hooks in](#how-it-hooks-in)
- [Extending](#extending)
- [FAQ](#faq)
- [Docs](#docs)
- [Contributing](#contributing)
- [License](#license)

---

<a id="why"></a>
## 🎯 Why

| Problem | Without it | With it |
|---|---|---|
| A tool call goes quiet | The UI just says "running" — slow, dead, or waiting for your approval? | Snapshot + event stream give a **verdict with reasons** (slow / hanging / stuck / silent / awaiting approval / error storm) |
| You want to stop one runaway call | You can only cancel the whole turn | **Force-stop by callId**, or "stop stuck calls" / "stop all turns" (with confirmation) |
| You need a post-mortem | Nothing recorded | One event per call (tool, argument preview, duration, result, error class) in events.jsonl |
| You don't want plugin tokens | Registering a tool costs context | **toolEnabled: false** by default — the model never sees it, **0 tokens** |

<a id="install"></a>
## 🚀 Install

```powershell
# official plugin channel (restart dsh afterwards)
dsh plugin --profile web add github:you233/dsh-jingcha

# self-tests (zero dependencies, no dsh required)
node test/verify.mjs          # 121 checks
node test/verify-client.mjs   #  90 checks (widget, DOM stubs)
```

Prefer no pnpm? tools/install.ps1 creates a junction and edits the profile manifest with an automatic backup
and one-command rollback. See [docs/SHARING.md](docs/SHARING.md).

<a id="features"></a>
## ✨ Features

- **Observation** — read-only hooks on tools/pre-execute, tools/execute, tools/result;
- **Verdicts** — slow / hanging / stuck / silent / awaiting-approval / error storm / plugin self-error;
- **Force stop** — fuses an AbortController of its own (upstream cancellation semantics untouched) and registers it
  already in pre-execute, so **nested sub-calls** can be stopped too; failures return a human-readable reason
  instead of killing the parent by mistake;
- **Widget** — draggable (position remembered), colour-graded by call duration, anomaly popups, hover-to-expand
  truncated text (flicker-free), five-corner reset, unified light/dark palette, hide-and-find-back, Ctrl+Shift+J;
- **HTTP API** — status / kill / stop / settings, loopback-only, Host allow-list, cross-site rejection, POST+JSON for mutations;
- **Persistence** — atomic status.json snapshot + rotating events.jsonl (8 MB rotation).

<a id="verdicts"></a>
## 🧭 Verdicts (defaults)

| Verdict | Trigger | Suggested action |
|---|---|---|
| slow | a call runs longer than 30s (slowCallMs) | check whether it is a legitimately long task |
| hanging | in-flight longer than 2min (hangCallMs) | watch it, maybe stop it |
| **stuck** | longer than 5min (stuckCallMs) **and** no progress | press "stop stuck calls" |
| silent | an agent is running but nothing streamed for 90s | look at the model side |
| awaiting approval | pre-execute blocked on approval for 20s | approve it — do not mistake it for a hang |
| error storm | 3 consecutive failures | stop and read the error classes |
| memory leak warning | RSS rises for 5 consecutive heartbeats and grows more than 10% (memoryLeakWindow / memoryLeakGrowth) | check for a real leak; raise the window/threshold for workloads that legitimately grow |

<a id="configuration"></a>
## ⚙️ Configuration

Everything lives in [cordis.patch.yml](cordis.patch.yml) with inline comments:
dataDir · displayName · toolEnabled · slowCallMs / hangCallMs / stuckCallMs · silenceMs · approvalWarnMs ·
autoKillAfterMs · memoryLeakWindow / memoryLeakGrowth · previewArgs / redactPreviews · apiToken.

<a id="security"></a>
## 🔒 Security

- Loopback only, Host allow-list (DNS-rebinding safe), cross-site Origin/Sec-Fetch-Site rejected,
  mutations require POST + application/json, optional shared token (apiToken);
- No network access, no third-party dependencies, no dynamic code execution; the widget uses textContent only;
- events.jsonl / status.json contain truncated argument previews with secret-ish fragments redacted;
- Residual risk: loopback means "everyone on this machine" — set apiToken on multi-user boxes.

See [SECURITY.md](SECURITY.md).

<a id="zero-model-tokens"></a>
## 🪙 Zero model tokens

By default no model-visible tool is registered (extras.tool is null in status.json) and neither the event stream
nor the widget enters the model context. Enable toolEnabled only if you want to ask "where is it stuck?" from the
session itself (cost: ~176 tokens per request for the tool description plus ~0.5k tokens per query).

<a id="how-it-hooks-in"></a>
## 🧩 How it hooks in

```
lib/core.js    pure logic: verdicts, counters, state machine (zero deps, unit-testable)
lib/index.js   host wiring: tool pipeline, fused abort signal, HTTP routes, heartbeat
lib/sink.js    persistence: atomic status.json + appended, rotating events.jsonl
lib/client.js  browser widget (single-file bundle, no require)
```

- **Force stop**: in pre-execute the plugin installs its own AbortController and replaces exec.signal; when DSH
  dispatches, it fuses the caller signal with ours — so upstream cancellation still works and we can abort on
  demand. At the end of the call the original signal is restored and the registration removed;
- **Widget colours** are computed client-side from call duration, while the verdict state travels separately;
- Spec: [lib/WIDGET-SPEC.md](lib/WIDGET-SPEC.md).

<a id="extending"></a>
## 🛠️ Extending

[docs/EXTENDING.md](docs/EXTENDING.md) lists the minimal edits for the five common changes (new verdict rule,
new route, new panel section, new setting, new language/colour scheme) — usually 2 to 6 places.

<a id="faq"></a>
## ❓ FAQ

- **It will not stop.** A same-process loop that ignores exec.signal cannot be killed hard (the plugin can only
  abort the signal); subprocesses such as pwsh are really killed. For nested calls with only the parent alive the
  plugin refuses explicitly instead of killing the parent;
- **Can it break tool calls?** Every monitoring path is wrapped in safe(); exceptions are swallowed and counted in
  pluginErrors, never affecting tool results;
- **How large does the data get?** events.jsonl rotates at 8 MB keeping one previous file (~16 MB cap), status.json
  is always a single snapshot.

<a id="docs"></a>
## 📚 Docs

| File | Content |
|---|---|
| [docs/SHARING.md](docs/SHARING.md) | install for others / uninstall / pre-share safety checklist |
| [docs/EXTENDING.md](docs/EXTENDING.md) | minimal edits for the five common changes |
| [docs/PUBLISHING.md](docs/PUBLISHING.md) | maintainer release flow |
| [lib/WIDGET-SPEC.md](lib/WIDGET-SPEC.md) | widget specification and acceptance list |
| [CHANGELOG.md](CHANGELOG.md) | version history |

<a id="contributing"></a>
## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Keep the three rules: observe only, keep host and widget settings in sync,
never rebuild interactive controls during a poll.

<a id="license"></a>
## 📄 License

MIT — see [LICENSE](LICENSE).
