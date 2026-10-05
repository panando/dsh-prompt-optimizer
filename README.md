# @panando/dsh-prompt-optimizer

<p align="center">
  <a href="README.md"><kbd>English</kbd></a>
  &nbsp;|&nbsp;
  <a href="README.zh-CN.md"><kbd>中文</kbd></a>
</p>

**One button prompt optimizer with configurable strategy.**

A prompt optimizer for the [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) composer. It turns a rough draft into a clearer, more actionable instruction and streams the result back into the composer for you to review — one click, with the model and generation strategy fully under your control.

---

## Features

### Optimizing

- **One-click optimization.** A single button beside the composer rewrites the current draft, preserving your intent while making it clearer, more specific, and easier for a coding agent to act on.
- **Editable optimization prompt.** The full prompt template is yours to rewrite. It is split into an independent **Prompt** half and **Few-shot** half, each with its own restore-default action, grouped under one collapsible *Optimizer prompt template* block.
- **Custom few-shot examples.** Teach the plugin your preferred rewrite style with up to 16 examples. Each example is either an *original prompt → optimized prompt* pair or a *broad task hint → optimized task instruction* pair, and each can be enabled, disabled, edited, or deleted.
- **Bounded, predictable output.** Token and request-time limits are configurable, and the built-in prompt steers the model to expand the instruction rather than summarize or answer it.

### Model and strategy

- **Follow the session model (default).** Generation uses whatever provider and model the current DSH session already selected — zero extra configuration.
- **Pin a specific model.** Choose any provider/model from the DSH catalog and pin it for the plugin, independent of the session selection.
- **Configurable reasoning effort.** Pick *Fastest (no reasoning)* for speed, or step up to *Low / High / Max* when a rewrite genuinely benefits from deeper analysis.

### Compositor experience

- **Streamed into the composer.** Output arrives token by token and lands in the draft for review — the plugin never sends a message on your behalf.
- **Interruptible.** Click the button again during generation to cancel the in-flight request.
- **Undo / redo drafts.** Step backward and forward through the generated draft history with `Ctrl+Z` / `Ctrl+Y` in the composer.

### Scope and privacy

- **Local, not a third-party service.** Generation calls the model route configured in DSH. The plugin does not proxy your draft to any separate optimization service.
- **Draft-and-prompt only.** The active optimization path sends the composer draft and the configured local prompt. Project-context collection and empty-draft prompt design are implemented in the codebase but currently disabled behind feature switches, so no project files or session history are collected.

---

## Installation

Requires DeepSeek Harness `0.2.x` (`0.2.0-rc.1` or newer).

Install from npm:

```sh
dsh plugin --profile web add @panando/dsh-prompt-optimizer
```

Or from GitHub:

```sh
dsh plugin --profile web add github:panando/dsh-prompt-optimizer
```

Restart DSH afterwards.

Update and remove:

```sh
dsh plugin --profile web update @panando/dsh-prompt-optimizer
dsh plugin --profile web remove @panando/dsh-prompt-optimizer
```

---

## Usage

1. Open a project session in DeepSeek Harness.
2. Write the task you want to improve in the composer.
3. Click the **提示词优化 / Prompt Optimizer** button beside the composer actions.
4. Review and edit the generated draft, then send it when ready.

| Action | Result |
| --- | --- |
| Click the optimizer with a non-empty draft | Streams an optimized instruction into the composer. |
| Click again while generation runs | Cancels the current request. |
| `Ctrl+Z` / `Ctrl+Y` in the composer | Moves backward / forward through generated draft history. |
| Press Enter after reviewing | Sends the visible composer draft through DSH. |

---

## Settings

Open **Settings → 提示词优化 / Prompt Optimizer**.

- **Model route** — follow the current session by default, or pin a provider/model from the DSH catalog.
- **Generation mode** — defaults to *Fastest (no reasoning)*; raise it only when the rewrite benefits from deeper analysis.
- **Optimizer prompt template** — a collapsible block holding the editable **Prompt** half, the **Few-shot** half, and your custom **Few-shot examples**; each template half has its own restore-default action.
- **Advanced generation limits** — maximum output tokens and request timeout.

Project-context controls are hidden while project-context collection is disabled.

---

## Development

Requires Node.js 22.19 or newer.

```sh
npm ci
npm run build      # generate lib/ artifacts
npm test           # run the test suite
```

Run the complete local check before proposing a change:

```sh
npm run check      # build + test + npm pack --dry-run
```

### Project structure

```text
src/index.cjs              DSH host integration, model routing, and RPC
src/core.cjs               Prompt assembly, settings, and bounded request data
src/optimizer-template.cjs Local default optimization prompt and few-shot section
src/client-factory.cjs     Composer button and settings interface
src/features.cjs           Feature switches for archived capabilities
cordis.patch.yml           DSH bundle configuration (enables the plugin entry)
scripts/build.mjs          Build host and client artifacts
lib/                       Generated package artifacts
```

### Contributing

Issues and focused pull requests are welcome. Please describe the user-visible
problem, keep changes focused with tests, and include the result of
`npm run check`.

---

## FAQ

**Why does an empty composer draft do nothing?**
Empty-draft prompt design is currently disabled. Enter a draft first.

**Does this send my project files to the model?**
No. The active path sends only the composer draft and the configured prompt. Project-context collection is disabled.

**Which model generates the result?**
The model selected for the current DSH session by default; you can pin a specific one in settings.

**Can I change the default prompt?**
Yes — the Prompt half, the Few-shot half, and your custom few-shot examples are all editable in settings.

---

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

This project is a fork of **[dsh-prompt-for-me](https://github.com/XXXXXQ-0206/dsh-prompt-for-me)** by the dsh-prompt-for-me contributors (MIT). We gratefully acknowledge the original authors for the plugin architecture, the host/client split, the model-catalog and settings services, and the streaming composer integration that this project builds on.

Changes made in this fork:

- Repackaged and republished under `@panando/dsh-prompt-optimizer`; package name, plugin id, RPC route, settings storage keys, and the CSS prefix (`dsh-pfm-` → `dsh-po-`) were renamed.
- Display label changed to 提示词优化.
- Fixed the model-select height in the settings panel (a `flex-basis` was resolving against the wrong axis).
- Reworked the optimizer-template section into a single collapsible block and removed the redundant restore-all button.

The default prompt template is derived from Trae and adapted for this plugin. This attribution does not imply endorsement or affiliation.

## Disclaimer

This software is provided **“AS IS”**, without warranties of any kind. To the fullest extent permitted by law, the authors and contributors are not liable for any damages arising from the use of this software. You use it at your own risk and are responsible for complying with applicable laws and provider terms. Do not use this software for unlawful purposes.