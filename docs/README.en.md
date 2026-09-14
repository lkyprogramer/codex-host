<div align="center">

# CodexHost

**Run Pi and other Harnesses inside Codex Desktop**

We believe **Codex Desktop** currently provides the best desktop development experience.

But **Codex** is not the only capable **Agent Harness**. Some people prefer **Claude Code** or **Pi Agent**.

**CodexHost** lets you choose the **Agent** that actually executes the task inside **Codex Desktop**, while keeping the native Codex experience and letting those Agents work together.

⭐ If this project helps you, please give it a Star! ⭐

<p>
  <a href="https://opensource.org/licenses/MIT"><img alt="license MIT" src="https://img.shields.io/badge/license-MIT-1f6feb?logo=open-source-initiative&logoColor=white" /></a>
  <a href="https://linux.do"><img alt="LINUX DO" src="https://shorturl.at/ggSqS" /></a>
</p>

<p>
  <a href="https://pi.dev/"><img alt="Pi" src="https://img.shields.io/badge/Pi-000000?logo=pi&logoColor=white" /></a>
  <a href="https://openai.com/codex/"><img alt="Codex" src="imgs/badge-codex.svg" /></a>
  <a href="https://code.claude.com/docs/en/quickstart"><img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-D97757?logo=claudecode&logoColor=white" /></a>
  <a href="https://opencode.ai/docs/"><img alt="OpenCode" src="imgs/badge-opencode.svg" /></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek-4D6BFE?logo=deepseek&logoColor=white" /></a>
  <a href="https://grok.com/"><img alt="Grok" src="https://img.shields.io/badge/Grok-000000?logo=x&logoColor=white" /></a>
  <a href="https://github.com/can1357/oh-my-pi"><img alt="Oh My Pi" src="imgs/badge-omp-v5.svg" /></a>
  <a href="https://antigravity.google/product/antigravity-cli"><img alt="AGY" src="imgs/badge-agy.svg" /></a>
  <a href="https://kiro.dev/docs/cli/"><img alt="Kiro CLI" src="imgs/badge-kiro.svg" /></a>
  <a href="https://www.codebuddy.cn/home/"><img alt="CodeBuddy" src="imgs/badge-codebuddy.svg" /></a>
  <a href="https://cursor.com/docs/cli/overview"><img alt="Cursor" src="imgs/badge-cursor.svg" /></a>
</p>

<p align="center">
  <sub><a href="../README.md">简体中文</a> · English · <a href="README.ko.md">한국어</a></sub>
</p>
</div>

<p align="center">
  <strong>Quick navigation:</strong>
  <a href="#interface-preview">Interface preview</a> •
  <a href="#quick-start">Quick start</a> •
  <a href="#feature-status">Feature status</a> •
  <a href="#cross-agent-collaboration">Cross-Agent collaboration</a> •
  <a href="#remote-harness">Remote</a> •
  <a href="#join-the-community">Community</a> •
  <a href="#development">Development</a>
</p>


## Interface Preview

No app switching required: **Pi, Claude Code, OpenCode, OMP, Grok Build, and DeepSeek Harness** can all run directly in the same Codex Desktop window.

https://github.com/user-attachments/assets/c48192d7-23ff-4f6e-b61a-6345a655bb76

### Interface

<div align="center">
  <img width="90%" src="imgs/codexhost-interface-overview.png" alt="Pi, Claude Code, OpenCode, Oh My Pi, Grok Build, and DeepSeek Harness running as independent Threads in Codex Desktop">
</div>

## Quick Start

**Use npm**

> Supports macOS, Windows, and [x64/ARM64 Linux](linux.md).

```bash
npm install -g @codexhost/cli
codexhost
```

**Or download** [installers](https://github.com/BytePioneer-AI/codex-host/releases) (macOS, Windows)

<details>
<summary>Installation troubleshooting</summary>

**macOS** - Apple verification issue

If the app cannot be verified when you first open it, run:

```bash
xattr -dr com.apple.quarantine /Applications/codexhost.app
```

**Windows** - Portable/extracted Codex Desktop

If you use a portable build, set `CODEXHOST_INSTALL_ROOT` to the extracted Codex Desktop directory:

```powershell
[Environment]::SetEnvironmentVariable("CODEXHOST_INSTALL_ROOT", "D:\CodexPortable", "User")
```

Fully quit Codex Desktop, open a new terminal, and start codexhost.

</details>

### Appearance settings

In `Settings → Appearance`, enable **Wrap thinking text** to wrap long lines in the persisted thinking transcript. It is off by default, saved locally, and takes effect immediately. Ordinary shell output is unchanged.

### Update checks and GitHub rate limits

codexhost prefers an authenticated [GitHub CLI](https://cli.github.com/) (`gh auth login --hostname github.com`) for latest Release checks, using the account's API quota to reduce anonymous rate limits on shared proxy exits. Credentials remain managed by `gh`; codexhost does not read or store tokens.

If `gh` is missing, unauthenticated, or fails, discovery falls back to the public API. Each CLI invocation is limited to 5 seconds. Discovery searches PATH, macOS Homebrew, and common Windows/Linux installation locations. Set `CODEXHOST_GH_COMMAND` in the Host environment to specify an executable path without arguments. Artifact downloads and verification are unchanged; authenticated requests remain subject to GitHub account and secondary rate limits.

### Interaction Examples

<table>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>Full workspace</strong></p>
      <div align="center">
        <img width="90%" src="imgs/codexhost-full-workspace.png" alt="The complete CodexHost workspace in Codex Desktop, showing the project tree, conversation area, and multiple Agent selectors">
      </div>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p><strong>Agent and Model selection</strong></p>
      <img src="imgs/agent-harness-selector.png" alt="Choose the Agent and Model that will execute the task before submitting; Codex, Pi, Claude Code, OpenCode, DeepSeek Harness, Grok, and Oh My Pi are available">
    </td>
    <td width="50%" valign="top">
      <p><strong>Usage and cost information</strong></p>
      <img src="imgs/usage-panel.png" alt="The Usage panel shows context, cache hits, and estimated cost">
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <img src="imgs/grok-usage-limits.png" alt="Remaining allowance and reset times for the five-hour and seven-day windows">
      <p>The macOS menu bar icon and Windows taskbar icon show the remaining allowance percentage, preferring the five-hour window and falling back to the seven-day window.</p>
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>Mermaid diagram rendering</strong></p>
      <div align="center">
        <img width="90%" src="imgs/codex-vs-pi-agent-tui.png" alt="Comparison of Mermaid diagram rendering between Pi with Codex Desktop and the Pi Agent TUI">
      </div>
    </td>
  </tr>
</table>

## Feature Status

Official Codex keeps its native app-server path. The current source [preinstalled distribution manifest](../scripts/release/harness-plugins.json) lists ten external Harnesses. Plugins, native CLIs, and authentication are managed separately; installing codexhost does not install or sign in to each Harness.

This is an integration overview, not certification of every native version. Configuration and interactions follow the target Host's current inspection and Session capabilities. Adapters project streaming, tools, diffs, and usage from native facts.

| Harness | Native interface | Fork / edit previous message | Main boundary |
| --- | --- | --- | --- |
| Pi | JSONL RPC | Supported, including cross-directory Fork | No equivalent Permission Mode; local native Session import |
| Oh My Pi (OMP) | JSONL RPC | Supported, including cross-directory Fork | Subagent observation depends on this transport's subscription probe |
| Claude Code | Agent SDK | Supported, same directory | Native project settings; Aqua Broker for managed macOS remote execution |
| OpenCode | SDK / Server / SSE | Supported, same directory | Configuration requires native readback; failed cancellation requests do not rewrite Turn outcomes |
| Grok | ACP + native extensions | Supported, including cross-directory Fork | Native interject and Plan; permission at creation; rollback derives a new Session |
| DeepSeek Harness | Managed Web / journal | Supported, same directory | Exact `0.1.2-rc.1` / `0.1.5-rc.1` support; local native Session import |
| Antigravity CLI | stream-json / Hook / native history | Supported, including cross-directory Fork | Skip permissions only; derivation validates existing native history and resources |
| Kiro CLI | ACP agent engine v3 | Supported, including cross-directory Fork | Invalid permission values are rejected; subagent observation without transcript reads |
| CodeBuddy | ACP | Unsupported | Native configuration and interactions; no Host-simulated history derivation |
| Cursor CLI | ACP + native history | Unsupported | Reasoning through native model variants; unattended execution uses native `--force` |

**Antigravity:** uses native `--dangerously-skip-permissions` only. codexhost does not add tool approvals or workspace access restrictions; see [permissions](antigravity-tool-approval.md) and [subagents](antigravity-subagents.md).

**Steering:** Sessions with native steering use interjection; other supported paths cancel, wait for the old Turn to finish, then start a new Turn. These are different operations. A ready fixed-model Harness can submit with an empty Model Catalog and keeps its own route. See [external Thread steering](external-thread-steering.md).

## Cross-Agent collaboration

**Idle resources:** the Host uses a shared lifecycle contract to suspend supported Harnesses after 60 idle seconds while retaining resumable Threads. Active work and unknown background jobs are not forcibly reclaimed. See [resource lifecycle and support limits](harness-resource-lifecycle.md).

You can ask the current Agent to hand an independent task to another Harness. For example:

> Ask `claude-code` to review this change independently and point out compatibility risks.
>
> Ask `pi` to investigate why this test fails intermittently.
>
> Ask `omp` to implement this feature while I continue working on the documentation.
>
> Ask `opencode` to verify this fix in an independent Thread and run the related tests.

codexhost creates a separate Native Session for the target Harness. The delegated session appears in the Codex Desktop conversation list, where you can open it, inspect progress, or continue the conversation.

<details>
<summary><h3 id="remote-harness">Remote Harness</h3></summary>


Use Harnesses on a remote node from Codex Desktop on your local machine. Tasks run on the remote machine while you keep using the unified Codex Desktop UI. Both ends need the same codexhost version.

**Two connection methods are supported:**

#### 1️⃣ SSH remote (recommended for Mac/Linux servers)

Connect to and control Harnesses on other development nodes over SSH. This requires Codex Desktop’s native SSH workspace.

| Client ↓ / Remote Host → | macOS | Linux | Windows |
| --- | --- | --- | --- |
| macOS | ✅ | ✅ | ❌ |
| Linux | ✅ | ✅ | ❌ |
| Windows | ✅ | ✅ | ❌ |

On the SSH remote host, run:

```bash
npm install -g @codexhost/cli
codexhost remote install
codexhost remote start
codexhost remote status
```

Then start Codex Desktop through local codexhost, open the SSH workspace, and choose the target Harness in the remote composer’s Agent/Model selector.

[SSH setup, diagnostics, and uninstall →](remote-ssh-host.md)

#### 2️⃣ Remote Control remote (experimental · recommended for Windows)

When Windows is the controlled Host, you can keep Codex Desktop’s official pairing, account authentication, and relay, and use Harnesses on Windows from the Codex Desktop of another paired computer. Official Remote Control must already be able to run native Codex tasks.

This path does not add a public service or TCP port. Harness credentials remain on the controlled Windows machine.

[Remote Control setup, transport boundary, and diagnostics →](remote-control-host.md)

</details>

<details>
<summary><h3>How it works</h3></summary>

codexhost integrates through each Harness's native interface: SDK for Claude Code, RPC for Pi / OMP, ACP for Grok / Kiro / CodeBuddy / Cursor, managed Web for DeepSeek, and CLI / Hook for Antigravity.

- **Desktop:** retain the official shell and enhance selection and presentation through CDP / Electron Inspector and the Renderer Extension.
- **Host:** forward official Codex requests; own external protocol projection, operation reservations, persistence, and recovery.
- **Plugins:** load explicitly enabled plugins on the target Host. Manifests describe identity and resources; Adapter / Session contracts report actual capabilities and state.
- **Native execution:** each Adapter owns native history, permission confirmation, cancellation, and cleanup.

See the [current architecture](harness-plugin-architecture.md) for boundaries and source entry points.

</details>

## Join the community

<table align="center">
  <tr>
    <td>
      <strong>Join the community</strong><br />
      <sub>Developers interested in CodexHost usage and features can scan the QR code to join the WeChat group.</sub>
      <ul>
        <li><sub>Ask installation questions in the group</sub></li>
        <li><sub>Feature suggestions and feedback</sub></li>
        <li><sub>Development discussion</sub></li>
        <li><sub>For bugs, please file an <strong>issue</strong></sub></li>
      </ul>
      <sub><strong>Contributions are welcome.</strong></sub>
    </td>
    <td align="center">
      <img width="230" alt="WeChat group QR code" src="https://github.com/user-attachments/assets/e40b162e-a961-43ac-9728-af59890c4d72" />
    </td>
  </tr>
</table>

## Development

Requirements: official Codex Desktop, Node.js 22.x (≥22.19) or 24.x, and Rust.

```bash
git clone https://github.com/BytePioneer-AI/codex-host
cd codex-host
npm ci
npm start
```

### Runtime architecture

Codex Desktop → CLI Shim / Host Runtime → official Codex app-server or plugin Loader → Harness Adapter / Session → native SDK, RPC, ACP, CLI, or Web process. The target Host's plugin directory supplies Renderer identity and presentation.

See [architecture](harness-plugin-architecture.md), [plugin runtime and trust](harness-plugin-runtime.md), and the [documentation index](index.md).

### Adding a Harness

Implement its Manifest, factory, Adapter, Session, and native protocol. Explicitly enable it in the user plugin directory and restart the Host. A new ID following the public contracts is discoverable by the Picker, configuration drafts, and Sidebar without adding per-name Renderer branches. Preinstallation is a separate distribution-manifest decision.

Declare real capability scopes, preserve environment and lifecycle semantics, and use the [conformance driver](adapter-conformance.md). The [codexhost-add-harness Skill](../.agents/skills/codexhost-add-harness/SKILL.md) provides implementation guidance.

### Validation

Choose checks for the change from [package.json](../package.json):

```bash
npm run typecheck
npm run lint
npm run test:typescript -- --maxWorkers=2
npm run test:rust
npm run test:e2e -- --workers=2
```

TypeScript tests build the workspace and plugins. Browser E2E uses synthetic pages and requires an available browser. Use focused tests when appropriate. `npm start` builds and launches Desktop, stopping existing Codex Desktop processes on macOS / Windows; `npm start -- --no-build` reuses artifacts.

The [2026-09-12 remediation record](full-project-review-2026-09-12/remediation/README.md) contains results for its frozen code snapshot: 3,771 TypeScript, 172 Rust, and 73 browser tests passed. These are prior results, not tests rerun for this documentation update or live Harness / Desktop / deployment certification.

## Acknowledgements

- Thanks to the [LINUX DO](https://linux.do/) community for its continued support.
- Thanks to the [Paseo](https://github.com/getpaseo/paseo) project for inspiring and informing the multi-Harness integration approach and architecture.
