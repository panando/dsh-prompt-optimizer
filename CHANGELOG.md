# Changelog

Notable changes to this project are documented here.

## [1.0.2] - 2026-10-05

### Fixed

- **Peer range silently excluded published harness prereleases.** The range
  `>=0.2.0-rc.1 <0.3.0` has no comparator on a prerelease version's exact
  `major.minor.patch` tuple, so node-semver dropped every build outside the
  `0.2.0` line — including the published `0.1.7-rc.2` and the current `alpha`
  `0.2.1-alpha.1`. Users on those builds hit `ERESOLVE` on install. All four
  `@deepseek-ai/*` peer entries now enumerate every published harness build
  (the same convention `@panando/dsh-pua` uses), and a test asserts the range
  keeps covering them.

## [1.0.1] - 2026-10-05

### Fixed

- **Web boot crash.** The client bundle hardcoded `id: "dsh-prompt-optimizer"`
  while the package is `@panando/dsh-prompt-optimizer`. DSH keys its client-module
  manifest by the package specifier, so a scoped package declaring a different id
  failed every DSH boot with `client-modules: duplicate factory registration for
  "dsh-prompt-optimizer"`. The bundle id is now derived from `package.json#name`,
  the build fails if the generated id ever diverges from it, and a test asserts
  the invariant. (v1.0.0 is unusable and should not be installed.)

## [1.0.0] - 2026-10-05

First release of `@panando/dsh-prompt-optimizer`.

> **Do not install 1.0.0** — it crashes DSH web boot; use 1.0.1 or later.

### Changed

- Forked from `dsh-prompt-for-me` and republished under the `@panando` npm scope: package name, plugin id, RPC route, settings storage keys, and CSS prefix (`dsh-pfm-` → `dsh-po-`) were all renamed.
- Display label changed from 嘴替 to 提示词优化.
- The optimizer-template settings section is retitled from 默认优化提示词模板 to 优化提示词模板 and is now a collapsible `<details>` block (collapsed by default, reusing the 高级设置 disclosure style). Expanding it shows the three parts in one place: 提示词, Few-shot, and Few-shot 示例.
- The model select now spans the full width of the model control instead of being capped at 240px, so its left and right edges align with the two model-choice cards above it.
- The Few-shot 示例 annotation is a single line: the empty-state limit line was folded into the hint text ("…；最多保存 16 条。").

### Fixed

- The model select in the settings panel no longer stretches to 240px tall. The shared `flex:0 1 240px` basis was resolving against the column-flex main axis (height) inside the model control; the select is now pinned to an intrinsic 36px row height.

### Removed

- The separate empty-state "最多保存 16 条示例。" paragraph in the Few-shot 示例 section (its text is now part of the single-line hint).
- The 全部恢复默认 ("restore all defaults") button from the optimizer-template footer; each template half already has its own 恢复默认 action.
- Upstream GitHub Actions workflows, Dependabot/CodeQL configuration, and contribution/conduct/security policy files.

## Upstream history (dsh-prompt-for-me)

The releases below belong to the upstream project this fork is based on.

### 1.0.0 - 2026-10-03

### Added

- Editable optimization prompt with separate prompt and few-shot sections, per-section restore-default actions, and a combined restore action.
- Custom few-shot library for prompt/optimized-prompt pairs and broad task/instruction pairs, with enable, disable, edit, and delete controls.
- English and Simplified Chinese README files with a language switch.
- Contribution, security, and conduct policies, plus CodeQL and Dependabot configuration.

### Changed

- The default optimization template identifies as a DeepSeek AI coding assistant while keeping the recovered prompt structure intact. Template attribution is documented in the README.
- Optimization sends only the composer draft and the configured local prompt to the selected DSH model.
- The package contents are limited to the installable plugin and user documentation.

### Removed

- Removed the obsolete service bridge, its transport code, configuration, and development batch command.
- Removed the manual generation shortcut and its keybinding path.
- Disabled project-context collection and empty-draft prompt design; their implementation remains archived behind feature switches.

## [0.7.0] - 2026-09-08

### Added

- Mode-aware streamed prompt generation, input locking, interruption, and undo/redo support.
- Documentation for forking the project on GitHub.
