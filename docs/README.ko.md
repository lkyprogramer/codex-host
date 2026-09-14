<div align="center">

# CodexHost

**Codex Desktop에서 Pi와 다른 Harness를 실행하세요**

저희는 **Codex Desktop**이 현재 최고의 데스크톱 개발 경험을 제공한다고 생각합니다.

하지만 **Codex**만이 뛰어난 **Agent Harness**인 것은 아닙니다. **Claude Code**나 **Pi Agent**를 선호하는 사람도 있습니다.

**CodexHost**를 사용하면 **Codex Desktop**의 기본 경험을 유지하면서 실제 작업을 실행할 **Agent**를 선택하고, 여러 Agent가 함께 작업하도록 할 수 있습니다.

⭐ 이 프로젝트가 도움이 되었다면 Star를 눌러 주세요! ⭐

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
  <sub><a href="../README.md">简体中文</a> · <a href="README.en.md">English</a> · 한국어</sub>
</p>
</div>

<p align="center">
  <strong>빠른 이동:</strong>
  <a href="#인터페이스-미리보기">인터페이스 미리보기</a> •
  <a href="#빠른-시작">빠른 시작</a> •
  <a href="#기능-상태">기능 상태</a> •
  <a href="#agent-간-협업">Agent 간 협업</a> •
  <a href="#원격-harness">원격 연결</a> •
  <a href="#교류-그룹-참여">교류 그룹</a> •
  <a href="#개발">개발</a>
</p>


## 인터페이스 미리보기

앱을 전환하지 않고도 **Pi, Claude Code, OpenCode, OMP, Grok Build, DeepSeek Harness**를 하나의 Codex Desktop 창에서 바로 사용할 수 있습니다.

https://github.com/user-attachments/assets/c48192d7-23ff-4f6e-b61a-6345a655bb76

### 인터페이스

<div align="center">
  <img width="90%" src="imgs/codexhost-interface-overview.png" alt="Codex Desktop에서 독립 Thread로 실행 중인 Pi, Claude Code, OpenCode, Oh My Pi, Grok Build, DeepSeek Harness">
</div>

## 빠른 시작

**npm 사용**

> macOS, Windows 및 [x64/ARM64 Linux](linux.md)를 지원합니다.

```bash
npm install -g @codexhost/cli
codexhost
```

**또는** [설치 프로그램](https://github.com/BytePioneer-AI/codex-host/releases) 다운로드 (macOS, Windows)

<details>
<summary>설치 문제 해결</summary>

**macOS** - Apple 인증 문제

처음 열 때 앱을 확인할 수 없다는 메시지가 표시되면 다음을 실행하세요:

```bash
xattr -dr com.apple.quarantine /Applications/codexhost.app
```

**Windows** - 휴대용/압축 해제 Codex Desktop

휴대용 버전을 사용하는 경우 `CODEXHOST_INSTALL_ROOT`를 Codex Desktop의 압축 해제 디렉터리로 설정하세요:

```powershell
[Environment]::SetEnvironmentVariable("CODEXHOST_INSTALL_ROOT", "D:\CodexPortable", "User")
```

Codex Desktop을 완전히 종료한 뒤, 새 터미널을 열고 codexhost를 시작하세요.

</details>

### 상호작용 예시

<table>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>전체 작업 화면</strong></p>
      <div align="center">
        <img width="90%" src="imgs/codexhost-full-workspace.png" alt="프로젝트 구조, 대화 영역 및 여러 Agent 선택기가 표시된 Codex Desktop의 CodexHost 전체 작업 화면">
      </div>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p><strong>Agent 및 Model 선택</strong></p>
      <img src="imgs/agent-harness-selector.png" alt="작업 제출 전에 실제 실행할 Agent와 Model을 선택할 수 있으며 Codex, Pi, Claude Code, OpenCode, DeepSeek Harness, Grok, Oh My Pi를 사용할 수 있습니다">
    </td>
    <td width="50%" valign="top">
      <p><strong>Usage 및 비용 정보</strong></p>
      <img src="imgs/usage-panel.png" alt="Usage 패널에서 컨텍스트, 캐시 적중 및 예상 비용을 확인할 수 있습니다">
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <img src="imgs/grok-usage-limits.png" alt="5시간 및 7일 기간의 남은 한도와 초기화 시간">
      <p>macOS 메뉴 막대 아이콘 및 Windows 작업 표시줄 아이콘에는 남은 한도 비율이 표시되며, 5시간 창을 우선 사용하고 없으면 7일 창으로 대체합니다.</p>
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>Mermaid 다이어그램 렌더링</strong></p>
      <div align="center">
        <img width="90%" src="imgs/codex-vs-pi-agent-tui.png" alt="Pi + Codex Desktop과 Pi Agent TUI의 Mermaid 다이어그램 렌더링 비교">
      </div>
    </td>
  </tr>
</table>

## 기능 상태

공식 Codex는 네이티브 app-server 경로를 유지합니다. 현재 소스의 [사전 설치 배포 목록](../scripts/release/harness-plugins.json)에는 외부 Harness 10개가 있습니다. 플러그인, 네이티브 CLI, 로그인 상태는 별도로 관리하며 codexhost 설치가 각 Harness의 설치나 로그인을 대신하지 않습니다.

아래 표는 연동 방식과 제한 사항이며 모든 네이티브 버전의 실기기 검증을 뜻하지 않습니다. 설정과 상호작용은 대상 Host의 현재 inspection 및 Session 기능을 따릅니다. 스트리밍, 도구, Diff, Usage는 네이티브 데이터에서 투영합니다.

| Harness | 네이티브 인터페이스 | Fork / 이전 메시지 수정 | 주요 제한 |
| --- | --- | --- | --- |
| Pi | JSONL RPC | 지원, 다른 디렉터리 Fork 포함 | 동등한 Permission Mode 없음; 로컬 네이티브 Session 가져오기 |
| Oh My Pi (OMP) | JSONL RPC | 지원, 다른 디렉터리 Fork 포함 | 현재 transport의 구독 확인 결과에 따라 하위 에이전트 관찰 |
| Claude Code | Agent SDK | 같은 디렉터리에서 지원 | 네이티브 프로젝트 설정; macOS 관리형 원격 실행은 Aqua Broker 사용 |
| OpenCode | SDK / Server / SSE | 같은 디렉터리에서 지원 | 설정은 네이티브 재조회로 확인; 취소 요청 실패가 Turn 결과를 덮어쓰지 않음 |
| Grok | ACP + 네이티브 확장 | 지원, 다른 디렉터리 Fork 포함 | 네이티브 삽입 및 Plan; 생성 시 권한 설정; rollback은 새 Session 파생 |
| DeepSeek Harness | 관리형 Web / journal | 같은 디렉터리에서 지원 | `0.1.2-rc.1` / `0.1.5-rc.1`만 지원; 로컬 네이티브 Session 가져오기 |
| Antigravity CLI | stream-json / Hook / 네이티브 기록 | 지원, 다른 디렉터리 Fork 포함 | Skip permissions만 제공; 파생 시 기존 네이티브 기록 및 리소스 검증 |
| Kiro CLI | ACP agent engine v3 | 지원, 다른 디렉터리 Fork 포함 | 잘못된 권한 값 거부; 하위 에이전트 관찰 지원, 과정 본문 읽기 미지원 |
| CodeBuddy | ACP | 미지원 | 네이티브 설정 및 상호작용; Host에서 기록 파생을 모방하지 않음 |
| Cursor CLI | ACP + 네이티브 기록 | 미지원 | 추론 강도는 네이티브 모델 변형으로 선택; 무인 실행은 네이티브 `--force` 사용 |

**Antigravity:** 네이티브 `--dangerously-skip-permissions`만 사용합니다. codexhost는 도구 승인이나 작업 공간 접근 제한을 추가하지 않습니다. [권한](antigravity-tool-approval.md)과 [하위 에이전트](antigravity-subagents.md) 설명을 참조하세요.

**실행 중 방향 조정:** 네이티브 steering이 있는 Session은 삽입을 사용하고, 다른 지원 경로는 취소 → 이전 Turn 종료 대기 → 새 Turn 시작 순서를 사용합니다. 고정 모델 Harness는 Model Catalog가 비어 있어도 준비 상태라면 자신의 경로로 제출할 수 있습니다. [외부 Thread steering](external-thread-steering.md)을 참조하세요.

## Agent 간 협업

**유휴 리소스:** Host는 공통 생명주기 계약으로 안전한 일시 중단을 지원하는 Harness의 네이티브 리소스를 유휴 60초 후 해제하고, Thread는 유지하여 필요할 때 복원합니다. 실행 중이거나 상태를 확인할 수 없는 백그라운드 작업은 강제로 종료하지 않습니다. [리소스 생명주기와 지원 범위](harness-resource-lifecycle.md)를 참조하세요.

현재 Agent에게 독립 작업을 다른 Harness로 넘기도록 요청할 수 있습니다. 예를 들면 다음과 같습니다.

> `claude-code`에게 이 변경 사항을 독립적으로 검토하고 호환성 위험을 지적하도록 요청하세요.
>
> `pi`에게 이 테스트가 간헐적으로 실패하는 원인을 조사하도록 요청하세요.
>
> 제가 문서를 정리하는 동안 `omp`에게 이 기능을 구현하도록 요청하세요.
>
> `opencode`에게 독립 Thread에서 이 수정을 검증하고 관련 테스트를 실행하도록 요청하세요.

codexhost는 대상 Harness를 위한 별도의 Native Session을 만듭니다. 위임된 Session은 Codex Desktop의 대화 목록에 표시되며, 언제든 열어서 진행 상황을 확인하거나 대화를 이어갈 수 있습니다.

<details>
<summary><h3 id="원격-harness">원격 Harness</h3></summary>


로컬 Codex Desktop에서 원격 노드의 Harness를 사용하여, 원격 컴퓨터에서 작업을 실행하면서 Codex Desktop의 통합 인터페이스를 계속 사용할 수 있습니다. 양쪽 끝에 동일한 버전의 codexhost를 설치해야 합니다.

**두 가지 연결 방식을 지원합니다:**

#### 1️⃣ SSH 원격 (Mac/Linux 서버에 권장)

SSH를 통해 다른 개발 노드의 Harness에 연결하고 제어합니다. Codex Desktop의 기본 SSH 작업 공간이 필요합니다.

| 클라이언트 ↓ / 원격 Host → | macOS | Linux | Windows |
| --- | --- | --- | --- |
| macOS | ✅ | ✅ | ❌ |
| Linux | ✅ | ✅ | ❌ |
| Windows | ✅ | ✅ | ❌ |

SSH 원격 Host에서 실행하세요:

```bash
npm install -g @codexhost/cli
codexhost remote install
codexhost remote start
codexhost remote status
```

그런 다음 로컬 codexhost를 통해 Codex Desktop을 시작하고 SSH 작업 공간을 연 뒤, 원격 입력창의 Agent/Model 선택기에서 원하는 Harness를 선택하세요.

[SSH 설정, 진단 및 제거 문서 보기 →](remote-ssh-host.md)

#### 2️⃣ Remote Control 원격 (실험 · Windows에 권장)

Windows가 제어 대상 Host인 경우, Codex Desktop의 공식 페어링, 계정 인증 및 relay를 유지하면서 이미 페어링된 다른 컴퓨터의 Codex Desktop에서 Windows의 Harness를 사용할 수 있습니다. 공식 Remote Control에서 기본 Codex 작업이 이미 실행 가능해야 합니다.

이 연결 방식은 공개 서비스나 TCP 포트를 추가하지 않습니다. Harness 자격 증명은 제어 대상 Windows 컴퓨터에 그대로 유지됩니다.

[Remote Control 설정, 전송 경계 및 진단 →](remote-control-host.md)

</details>

<details>
<summary><h3>작동 방식</h3></summary>

codexhost는 각 Harness의 네이티브 인터페이스를 사용합니다. Claude Code는 SDK, Pi / OMP는 RPC, Grok / Kiro / CodeBuddy / Cursor는 ACP, DeepSeek은 관리형 Web, Antigravity는 CLI / Hook으로 연동합니다.

- **Desktop:** 공식 외형을 유지하고 CDP / Electron Inspector와 Renderer Extension으로 선택 및 표시 기능을 보완합니다.
- **Host:** 공식 Codex 요청을 전달하며 외부 프로토콜 투영, 작업 예약, 영속화와 복구를 담당합니다.
- **플러그인:** 대상 Host에서 명시적으로 활성화된 플러그인을 로드합니다. Manifest는 식별과 리소스, Adapter / Session은 실제 기능과 상태를 제공합니다.
- **네이티브 실행:** 기록, 권한 확인, 취소 및 자원 정리는 각 Adapter가 담당합니다.

경계와 소스 진입점은 [현재 아키텍처](harness-plugin-architecture.md)를 참조하세요.

</details>

## 교류 그룹 참여

<table align="center">
  <tr>
    <td>
      <strong>교류 그룹 참여</strong><br />
      <sub>CodexHost 사용법과 기능에 관심 있는 개발자는 QR 코드를 스캔해 위챗 그룹에 참여할 수 있습니다.</sub>
      <ul>
        <li><sub>설치 문제는 그룹에서 질문할 수 있습니다</sub></li>
        <li><sub>기능 제안과 피드백</sub></li>
        <li><sub>개발 관련 논의</sub></li>
        <li><sub>버그는 <strong>issue</strong>로 제출해 주세요</sub></li>
      </ul>
      <sub><strong>함께 기여해 주세요.</strong></sub>
    </td>
    <td align="center">
      <img width="230" alt="위챗 그룹 QR 코드" src="https://github.com/user-attachments/assets/e40b162e-a961-43ac-9728-af59890c4d72" />
    </td>
  </tr>
</table>

## 개발

환경 요구 사항: 공식 Codex Desktop, Node.js 22.x(≥22.19) 또는 24.x, Rust.

```bash
git clone https://github.com/BytePioneer-AI/codex-host
cd codex-host
npm ci
npm start
```

### 실행 아키텍처

Codex Desktop → CLI Shim / Host Runtime → 공식 Codex app-server 또는 플러그인 Loader → Harness Adapter / Session → 네이티브 SDK, RPC, ACP, CLI 또는 Web 프로세스 순서입니다. 대상 Host의 플러그인 목록이 Renderer의 식별과 표시 정보를 제공합니다.

[아키텍처](harness-plugin-architecture.md), [플러그인 실행 및 신뢰 경계](harness-plugin-runtime.md), [문서 목록](index.md)을 참조하세요.

### Harness 추가

Manifest, 팩토리, Adapter, Session과 네이티브 프로토콜을 구현하고 사용자 플러그인 디렉터리에서 명시적으로 활성화한 뒤 Host를 재시작합니다. 공용 계약을 따르는 새 ID는 이름별 Renderer 분기를 추가하지 않아도 Picker, 설정 초안, Sidebar에 표시됩니다. 사전 설치는 배포 목록에서 별도로 결정합니다.

실제 기능 범위, 환경 격리와 수명 주기를 구현하고 [conformance driver](adapter-conformance.md)로 검증하세요. [codexhost-add-harness Skill](../.agents/skills/codexhost-add-harness/SKILL.md)에 구현 지침이 있습니다.

### 검증

변경 범위에 맞춰 [package.json](../package.json)의 명령을 선택하세요.

```bash
npm run typecheck
npm run lint
npm run test:typescript -- --maxWorkers=2
npm run test:rust
npm run test:e2e -- --workers=2
```

TypeScript 테스트는 Workspace와 플러그인을 빌드합니다. 브라우저 E2E는 합성 페이지를 사용하며 이용 가능한 브라우저가 필요합니다. 필요한 경우 관련 테스트만 실행하세요. `npm start`는 빌드 후 Desktop을 시작하며 macOS / Windows에서는 기존 Codex Desktop을 종료합니다. `npm start -- --no-build`는 기존 산출물을 재사용합니다.

[2026-09-12 수정 기록](full-project-review-2026-09-12/remediation/README.md)은 당시 코드 스냅샷의 TypeScript 3,771개, Rust 172개, 브라우저 73개 통과 결과를 보관합니다. 이번 문서 수정에서 재실행한 결과나 실제 Harness / Desktop / 배포 검증을 뜻하지 않습니다.

## 감사의 글

- 지속적인 지원을 보내 주신 [LINUX DO](https://linux.do/) 커뮤니티에 감사드립니다.
- 멀티 Harness 통합 방식과 아키텍처에 영감을 주고 참고가 된 [Paseo](https://github.com/getpaseo/paseo) 프로젝트에 감사드립니다.
