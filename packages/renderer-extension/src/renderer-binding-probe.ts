import {
  decodeHarnessPluginRoute,
  decodeHarnessCommandMention,
  DELEGATION_MENTION_PATH_PREFIX,
  HARNESS_COMMAND_MENTION_PATH_PREFIX,
  harnessIdSchema,
  permissionModeFixedAtCreate,
  stripDelegationMentions,
  type HarnessCommandDescriptor,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessModelSelectionState,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
  type HarnessPermissionModeScope,
  type HarnessThinkingOptionId,
  type AccountCreditsSnapshot,
  type ThreadInspection,
  type ThreadUsageInspection,
  type ThreadUsageSnapshot,
  type CodexhostError,
  type HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";

import {
  DEFAULT_RENDERER_AGENTS,
  LEGACY_RENDERER_AGENTS,
  DraftAgentController,
  type ComposerAgentPhase,
  type ExternalRendererAgent,
  type RendererAgent,
  type RendererAgentAvailability,
} from "./agent-selection-state.js";
import {
  CODEX_COMPOSER_SELECTOR,
  EDITOR_SELECTOR,
  composerForEditor,
  composerForElement,
  disposeComposerAgentControl,
  editorForElement,
  eventElement,
  isComposerInputIntent,
  isComposerSubmissionKey,
  mountComposerAgentControl,
  replaceComposerAgentPicker,
  reconcileComposerNativeControls,
  renderComposerAgentControl,
  refreshSendButton,
  sendButtonWithin,
  type ComposerAgentControl,
  type ExternalModelControlView,
  type ExternalPermissionModeControlView,
} from "./renderer-composer-dom.js";
import {
  rendererHarnessMessages,
  rendererStaticCommandsNotice,
} from "./renderer-harness-localization.js";
import {
  installRendererDelegationMention,
  type RendererDelegationMentionControl,
} from "./renderer-delegation-mention.js";
import { installReasoningTranscriptSoftWrap } from "./renderer-transcript-dom.js";
import { RendererCodexAccountState } from "./renderer-codex-account-state.js";
import {
  decodeAntigravityTransportModelId,
  decodeClaudeTransportModelId,
  decodeDeepSeekHarnessTransportModelId,
  decodeGrokTransportModelId,
  decodeOmpTransportModelId,
  decodeOpenCodeTransportModelId,
  decodePiTransportModelId,
  findComposerModelTarget,
  hostIdForComposer,
  threadIdFromComposerModelTarget,
  waitForRendererDraftPrewarmPolicy,
  type LockedComposerSelection,
  type RendererAdapterStatus,
  type RendererDraftPrewarmPolicy,
} from "./versioned-renderer-adapter.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import { RendererMethodUnavailableError } from "./renderer-request-sender.js";
import { thinkingOptionsForModel } from "./renderer-model-picker.js";
import { RENDERER_AGENT_INSTALL_URLS } from "./renderer-agent-picker.js";
import { rendererAgentLabel, type RendererAgentPresentation } from "./renderer-agent-icon.js";
import {
  readClaudePermissionModePreference,
  writeClaudePermissionModePreference,
} from "./renderer-permission-mode-preference.js";
import { isPermissionModeControlReady } from "./renderer-permission-mode-picker.js";
import {
  readNewThreadAgentPreference,
  readNewThreadExternalConfigurationPreference,
  writeNewThreadAgentPreference,
  writeNewThreadExternalConfigurationPreference,
} from "./renderer-new-thread-preference.js";
import { installRendererSidebarAgentIcons } from "./renderer-sidebar-agent-icons.js";
import {
  rendererHarnessCommandExecutesDirectly,
  routeRendererHarnessCommandSelection,
} from "./renderer-harness-command-claim.js";
import { installRendererSettingsLifecycle } from "./renderer-settings-lifecycle.js";
import { openRendererThread } from "./renderer-fork-control.js";
import type {
  RendererConnectionDiagnostics,
  RendererConnectionSnapshot,
} from "./settings/pages.js";

const externalAgents: readonly ExternalRendererAgent[] = LEGACY_RENDERER_AGENTS.filter(
  (agent) => agent !== "codex",
) as ExternalRendererAgent[];
type HarnessAvailability = Partial<Record<ExternalRendererAgent, RendererAgentAvailability>>;
type HarnessAvailabilityErrors = Partial<Record<ExternalRendererAgent, CodexhostError | undefined>>;
type HarnessWebUiAvailability = Partial<Record<ExternalRendererAgent, boolean>>;

function isRetryableHarnessAvailability(
  availability: RendererAgentAvailability | undefined,
  error: CodexhostError | undefined,
): boolean {
  return (
    availability !== undefined &&
    availability !== "ready" &&
    availability !== "notInstalled" &&
    error?.retryable === true
  );
}

export function retryableHarnessAvailabilityAgents(
  availability: HarnessAvailability,
  errors: HarnessAvailabilityErrors,
  agents: readonly ExternalRendererAgent[] = externalAgents,
): ExternalRendererAgent[] {
  return agents.filter((agent) =>
    isRetryableHarnessAvailability(availability[agent], errors[agent]),
  );
}

export function passiveHarnessAvailabilityAgents(
  availability: HarnessAvailability,
  errors: HarnessAvailabilityErrors,
  agents: readonly ExternalRendererAgent[] = externalAgents,
): ExternalRendererAgent[] {
  return agents.filter(
    (agent) =>
      availability[agent] === undefined ||
      availability[agent] === "checking" ||
      isRetryableHarnessAvailability(availability[agent], errors[agent]),
  );
}

/** Last known availability stays visible while inspect or retry is in flight. */
export function harnessAvailabilityDuringInspect(
  current: RendererAgentAvailability | undefined,
): RendererAgentAvailability {
  return current ?? "checking";
}

export function shouldRefreshCodexAccountsForAdapterState(
  state: RendererAdapterStatus["state"],
): boolean {
  return state === "ready";
}

export { resolveCodexAccountSelection } from "./renderer-codex-account-state.js";

interface HostHarnessAvailabilityState {
  codexAccounts: RendererCodexAccountState | null;
  directory: "unknown" | "directory" | "legacy";
  descriptors: ReadonlyMap<ExternalRendererAgent, HarnessPluginDescriptor>;
  availability: HarnessAvailability;
  errors: HarnessAvailabilityErrors;
  webUi: HarnessWebUiAvailability;
  requestGeneration: number;
  request: { client: RendererModelClient; promise: Promise<void> } | null;
  retryTimer: number | null;
  retryAttempt: number;
}

function agentsForHostState(state: HostHarnessAvailabilityState): readonly ExternalRendererAgent[] {
  return state.directory === "directory" ? [...state.descriptors.keys()] : externalAgents;
}

function presentationsForHostState(
  state: HostHarnessAvailabilityState,
): ReadonlyMap<RendererAgent, RendererAgentPresentation> {
  return state.descriptors;
}

const rendererUsageRefreshDelays = [250, 500, 1000, 2000, 4000, 8000] as const;

export function refreshConnectionHosts(
  hostIds: Iterable<string>,
  refreshHost: (hostId: string) => Promise<void>,
): Promise<void> {
  return Promise.all([...hostIds].map((hostId) => refreshHost(hostId))).then(() => undefined);
}

export function rendererUsageRefreshDelay(attempt: number): number {
  const index = Math.max(0, Math.min(Math.trunc(attempt), rendererUsageRefreshDelays.length - 1));
  return rendererUsageRefreshDelays[index] ?? rendererUsageRefreshDelays[0];
}

/**
 * Agents that can produce account-wide Credits independently of a Thread
 * Usage snapshot. These are the only ones where it is worth retrying purely
 * to pick up account limits after Usage has already arrived.
 */
function externalAgentHasAccountCredits(agent: RendererAgent): boolean {
  return agent === "codex" || agent === "grok" || agent === "claude-code";
}

export function shouldRetryExternalThreadUsage(
  agent: RendererAgent,
  usage: ThreadUsageSnapshot | null,
  accountCredits: AccountCreditsSnapshot | null = null,
): boolean {
  if (usage === null) return true;
  return externalAgentHasAccountCredits(agent) && accountCredits === null;
}

export function shouldReloadExternalCatalogAfterAvailabilityRefresh(
  previous: RendererAgentAvailability | undefined,
  next: RendererAgentAvailability,
  configurationReady: boolean,
  explicitRefresh = false,
): boolean {
  return explicitRefresh || previous !== next || !configurationReady;
}

function isExternalConfigurationReadyView(
  modelView: ExternalModelControlView,
  permissionModeView: ExternalPermissionModeControlView,
): boolean {
  return (
    modelView.status !== "selecting" &&
    (modelView.status === "empty" ||
      modelView.catalog?.models.some((model) => model.ref.id === modelView.selected?.id) ===
        true) &&
    isPermissionModeControlReady(permissionModeView)
  );
}

function isExternalConfigurationStable(
  modelView: ExternalModelControlView,
  permissionModeView: ExternalPermissionModeControlView,
): boolean {
  return (
    (modelView.status === "empty" && isPermissionModeControlReady(permissionModeView)) ||
    isExternalConfigurationReadyView(modelView, permissionModeView)
  );
}

export interface RendererBindingProbeStatus {
  version: 2;
  mountedComposers: number;
  enabledAgents: RendererAgent[];
  availability: HarnessAvailability;
  selections: Array<{
    composerId: string;
    agent: RendererAgent;
    phase: ComposerAgentPhase;
  }>;
  adapter: RendererAdapterStatus;
}

export interface RendererBindingProbeOptions {
  enabledAgents?: readonly RendererAgent[];
  defaultAgent?: RendererAgent;
}

type ApplyAdapterAgent = (
  agent: RendererAgent,
  model?: HarnessModelRef,
  thinkingOptionId?: HarnessThinkingOptionId,
  permissionModeId?: HarnessPermissionModeId,
  composer?: Element,
) => boolean;

export interface RendererBindingProbeApi {
  status(): RendererBindingProbeStatus;
  lockedSelection(): LockedComposerSelection | null;
  setAdapter(
    status: RendererAdapterStatus,
    dispose?: () => void,
    applyAgent?: ApplyAdapterAgent,
    modelControl?: RendererModelClient | null,
  ): void;
  dispose(): void;
}

declare global {
  interface Window {
    __codexhostRendererBindingProbeV1?: RendererBindingProbeApi;
  }
}

export type ComposerOwnershipStatus = "not-required" | "loading" | "ready" | "error";

export interface RestoredThreadOwnership {
  agent: RendererAgent;
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
}

function selectableThinkingOptionId(
  state: HarnessModelSelectionState,
): HarnessThinkingOptionId | undefined {
  return state.effectiveThinkingOptionId &&
    state.availableThinkingOptions?.some(({ id }) => id === state.effectiveThinkingOptionId)
    ? state.effectiveThinkingOptionId
    : undefined;
}

export function draftThinkingOptionForModel(
  catalog: HarnessModelCatalog,
  model: HarnessModelRef,
  requested: HarnessThinkingOptionId | undefined,
): HarnessThinkingOptionId | undefined {
  const options = thinkingOptionsForModel(catalog, model);
  return (
    options.find(({ id }) => id === requested)?.id ??
    options.find(({ id }) => id === catalog.defaultThinkingOptionId)?.id ??
    options[0]?.id
  );
}

export function draftPermissionMode(
  catalog: HarnessPermissionModeCatalog,
  requested: HarnessPermissionModeId | undefined,
): HarnessPermissionModeId {
  return (
    catalog.modes.find(({ id }) => id === requested)?.id ??
    catalog.modes.find(({ id }) => id === catalog.defaultModeId)?.id ??
    catalog.defaultModeId
  );
}

export function lockedPermissionMode(
  catalog: HarnessPermissionModeCatalog,
  effective: HarnessPermissionModeId | undefined,
  carrier: HarnessPermissionModeId | undefined,
): HarnessPermissionModeId | undefined {
  const restored = effective ?? carrier;
  if (restored && !catalog.modes.some(({ id }) => id === restored)) {
    throw new Error("Existing Thread Permission Mode is absent from the current Catalog");
  }
  return restored;
}

export function permissionModeSelectionLocked(input: {
  phase: ComposerAgentPhase;
  permissionModeScope?: HarnessPermissionModeScope;
}): boolean {
  return input.phase === "locked" && permissionModeFixedAtCreate(input);
}

export function shouldPersistNewThreadConfigurationSelection(phase: ComposerAgentPhase): boolean {
  return phase === "draft";
}

export function restoredThreadOwnership(inspection: ThreadInspection): RestoredThreadOwnership {
  if (inspection.owner === "codex") return { agent: "codex" };
  const pluginRoute = decodeHarnessPluginRoute(inspection.transportModelId);
  if (pluginRoute?.harnessId === inspection.harnessId) {
    const model = inspection.effectiveModel ?? pluginRoute.model;
    const thinkingOptionId =
      inspection.availableThinkingOptions !== undefined
        ? selectableThinkingOptionId(inspection)
        : (inspection.effectiveThinkingOptionId ?? pluginRoute.thinkingOptionId);
    const permissionModeId = inspection.effectivePermissionModeId ?? pluginRoute.permissionModeId;
    return {
      agent: inspection.harnessId,
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(permissionModeId ? { permissionModeId } : {}),
    };
  }
  if (inspection.harnessId === "pi") {
    const transportSelection = decodePiTransportModelId(inspection.transportModelId);
    if (!transportSelection) {
      throw new Error("Pi Thread reported an incompatible transport Model");
    }
    const model = inspection.effectiveModel ?? transportSelection.model;
    const thinkingOptionId =
      selectableThinkingOptionId(inspection) ?? transportSelection.thinkingOptionId;
    return {
      agent: "pi",
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(inspection.effectivePermissionModeId
        ? { permissionModeId: inspection.effectivePermissionModeId }
        : {}),
    };
  }
  if (inspection.harnessId === "grok") {
    const transportSelection = decodeGrokTransportModelId(inspection.transportModelId);
    if (!transportSelection) {
      throw new Error("Grok Thread reported an incompatible transport Model");
    }
    const model = inspection.effectiveModel ?? transportSelection.model;
    const thinkingOptionId =
      selectableThinkingOptionId(inspection) ?? transportSelection.thinkingOptionId;
    const permissionModeId =
      inspection.effectivePermissionModeId ?? transportSelection.permissionModeId;
    return {
      agent: "grok",
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(permissionModeId ? { permissionModeId } : {}),
    };
  }
  if (inspection.harnessId === "omp") {
    const transportSelection = decodeOmpTransportModelId(inspection.transportModelId);
    if (!transportSelection) throw new Error("OMP Thread reported an incompatible transport Model");
    const model = inspection.effectiveModel ?? transportSelection.model;
    const thinkingOptionId =
      selectableThinkingOptionId(inspection) ?? transportSelection.thinkingOptionId;
    const permissionModeId =
      inspection.effectivePermissionModeId ?? transportSelection.permissionModeId;
    return {
      agent: "omp",
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(permissionModeId ? { permissionModeId } : {}),
    };
  }
  if (inspection.harnessId === "claude-code") {
    const transportSelection = decodeClaudeTransportModelId(inspection.transportModelId);
    if (!transportSelection) {
      throw new Error("Claude Code Thread reported an incompatible transport Model");
    }
    const model = inspection.effectiveModel ?? transportSelection.model;
    const thinkingOptionId =
      selectableThinkingOptionId(inspection) ?? transportSelection.thinkingOptionId;
    const permissionModeId =
      inspection.effectivePermissionModeId ?? transportSelection.permissionModeId;
    return {
      agent: "claude-code",
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(permissionModeId ? { permissionModeId } : {}),
    };
  }
  if (inspection.harnessId === "deepseek-harness") {
    const transportSelection = decodeDeepSeekHarnessTransportModelId(inspection.transportModelId);
    if (!transportSelection) {
      throw new Error("DeepSeek Harness Thread reported an incompatible transport Model");
    }
    const model = inspection.effectiveModel ?? transportSelection.model;
    const permissionModeId =
      inspection.effectivePermissionModeId ?? transportSelection.permissionModeId;
    return {
      agent: "deepseek-harness",
      ...(model ? { model } : {}),
      ...(permissionModeId ? { permissionModeId } : {}),
    };
  }
  if (inspection.harnessId === "opencode") {
    const transportSelection = decodeOpenCodeTransportModelId(inspection.transportModelId);
    if (!transportSelection) {
      throw new Error("OpenCode Thread reported an incompatible transport Model");
    }
    const model = inspection.effectiveModel ?? transportSelection.model;
    const thinkingOptionId =
      selectableThinkingOptionId(inspection) ?? transportSelection.thinkingOptionId;
    const permissionModeId =
      inspection.effectivePermissionModeId ?? transportSelection.permissionModeId;
    return {
      agent: "opencode",
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(permissionModeId ? { permissionModeId } : {}),
    };
  }
  if (inspection.harnessId === "antigravity") {
    const transportSelection = decodeAntigravityTransportModelId(inspection.transportModelId);
    if (!transportSelection) {
      throw new Error("Antigravity Thread reported an incompatible transport Model");
    }
    const model = inspection.effectiveModel ?? transportSelection.model;
    const thinkingOptionId =
      selectableThinkingOptionId(inspection) ?? transportSelection.thinkingOptionId;
    const permissionModeId =
      inspection.effectivePermissionModeId ?? transportSelection.permissionModeId;
    return {
      agent: "antigravity",
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(permissionModeId ? { permissionModeId } : {}),
    };
  }
  if (
    inspection.harnessId === "kiro-cli" ||
    inspection.harnessId === "codebuddy" ||
    inspection.harnessId === "cursor-cli"
  ) {
    const route = decodeHarnessPluginRoute(inspection.transportModelId);
    if (!route || route.harnessId !== inspection.harnessId) {
      throw new Error("Plugin Thread reported an incompatible transport Model");
    }
    const model = inspection.effectiveModel ?? route.model;
    const thinkingOptionId =
      inspection.harnessId === "cursor-cli"
        ? undefined
        : inspection.availableThinkingOptions !== undefined
          ? selectableThinkingOptionId(inspection)
          : (inspection.effectiveThinkingOptionId ?? route.thinkingOptionId);
    const permissionModeId = inspection.effectivePermissionModeId ?? route.permissionModeId;
    return {
      agent: inspection.harnessId,
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(permissionModeId ? { permissionModeId } : {}),
    };
  }
  throw new Error("Thread owner is not a Renderer Agent");
}

export function isOwnershipSubmissionBlocked(status: ComposerOwnershipStatus): boolean {
  return status === "loading" || status === "error";
}

interface MountedComposer {
  composer: Element;
  composerId: string;
  control: ComposerAgentControl;
  modelTarget: readonly unknown[] | null;
  modelView: ExternalModelControlView;
  permissionModeView: ExternalPermissionModeControlView;
  ownershipStatus: ComposerOwnershipStatus;
  threadConfiguration: HarnessModelSelectionState | undefined;
  usage: ThreadUsageSnapshot | null;
  accountCredits: AccountCreditsSnapshot | null;
  hostId: string | null;
  usageRequestGeneration: number;
  commandRequestGeneration: number;
  commandStatus: "idle" | "loading" | "ready" | "error";
  commandError: string | null;
}

interface PendingComposerReplacement {
  source: MountedComposer;
  sourceModelTarget: readonly unknown[] | null;
}

type SubmissionTrigger = "click" | "enter" | "submit";

export function shouldTransferComposerState(
  sourceTarget: readonly unknown[] | null,
  replacementTarget: readonly unknown[] | null,
  sourcePhase: ComposerAgentPhase,
  submissionPending = false,
): boolean {
  if (!sourceTarget || !replacementTarget) return false;
  if (
    sourceTarget.length === replacementTarget.length &&
    sourceTarget.every((value, index) => value === replacementTarget[index])
  ) {
    return true;
  }
  return (
    (sourcePhase === "locked" || submissionPending) &&
    sourceTarget[0] === "default" &&
    replacementTarget[0] === "conversation"
  );
}

export function isLateConversationTarget(
  mountedTarget: readonly unknown[] | null,
  currentTarget: readonly unknown[] | null,
): boolean {
  if (currentTarget?.[0] !== "conversation") return false;
  if (mountedTarget === null) return true;
  if (mountedTarget?.[0] === "default") return true;
  if (mountedTarget?.[0] !== "conversation") return false;
  return (
    mountedTarget.length !== currentTarget.length ||
    mountedTarget.some((value, index) => value !== currentTarget[index])
  );
}

export function lateConversationTargetResolution(
  mountedTarget: readonly unknown[] | null,
  currentTarget: readonly unknown[] | null,
  sourcePhase: ComposerAgentPhase,
  submissionPending = false,
): "none" | "transfer" | "inspect" {
  if (!isLateConversationTarget(mountedTarget, currentTarget)) return "none";
  return mountedTarget?.[0] === "default" && (sourcePhase === "locked" || submissionPending)
    ? "transfer"
    : "inspect";
}

export function scopedComposerTarget(
  target: readonly unknown[] | null,
  hostId: string | null,
): readonly unknown[] | null {
  if (target?.[0] !== "conversation" || !hostId) return target;
  return ["conversation", target[1], hostId];
}

export function isComposerModelWriteAllowed(target: readonly unknown[] | null): boolean {
  return target?.[0] === "default";
}

export function shouldApplyDraftAgentCarrier(agent: RendererAgent): boolean {
  // Codex must also pass through the policy so it clears a previous external
  // plugin carrier. Every valid external Harness writes the shared carrier.
  return agent === "codex" || harnessIdSchema.safeParse(agent).success;
}

export function applyComposerModelWrite(
  target: readonly unknown[] | null,
  write: () => boolean,
): boolean {
  if (target?.[0] === "conversation") return true;
  if (!isComposerModelWriteAllowed(target)) return false;
  return write();
}

function mutationMayChangeComposerTarget(mutation: MutationRecord): boolean {
  const target =
    mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
  return !target || editorForElement(target) === null;
}

function catalogWithConfigurationState(
  catalog: HarnessModelCatalog,
  model: HarnessModelRef,
  state: HarnessModelSelectionState,
): HarnessModelCatalog {
  if (!state.availableThinkingOptions) return catalog;
  const supportedThinkingOptionIds = state.availableThinkingOptions.map(({ id }) => id);
  const models = catalog.models.map((candidate) => {
    const normalized = { ...candidate };
    delete normalized.supportedThinkingOptionIds;
    return candidate.ref.id === model.id
      ? { ...normalized, supportedThinkingOptionIds }
      : normalized;
  });
  const normalized = {
    ...catalog,
    models,
    defaultModel: model,
    thinkingOptions: state.availableThinkingOptions,
  };
  if (state.effectiveThinkingOptionId) {
    normalized.defaultThinkingOptionId = state.effectiveThinkingOptionId;
  } else {
    delete normalized.defaultThinkingOptionId;
  }
  return normalized;
}

export function installRendererBindingProbe(
  options: RendererBindingProbeOptions = {},
): RendererBindingProbeApi {
  const existing = window.__codexhostRendererBindingProbeV1;
  if (existing) return existing;

  const configuredEnabledAgents = [...new Set(options.enabledAgents ?? DEFAULT_RENDERER_AGENTS)];
  let enabledAgents = [...configuredEnabledAgents];
  const controller = new DraftAgentController<Element>({
    enabledAgents,
    ...(options.defaultAgent ? { defaultAgent: options.defaultAgent } : {}),
  });
  const mountedByComposer = new Map<Element, MountedComposer>();
  const pendingReplacements = new Map<Element, PendingComposerReplacement>();
  let disposed = false;
  const disposeReasoningSoftWrap = installReasoningTranscriptSoftWrap(document);
  let scanScheduled = false;
  let refreshTargetsOnNextScan = false;
  let adapterDispose: (() => void) | null = null;
  let applyAdapterAgent: ApplyAdapterAgent | null = null;
  let modelControl: RendererModelClient | null = null;
  const activeModelHostId = (composer?: Element): string | null => {
    const routedHostId = hostIdForComposer(composer);
    if (routedHostId !== undefined) return routedHostId;
    if (!modelControl) return null;
    return modelControl.currentHostId ? modelControl.currentHostId() : "local";
  };
  const controllerTarget = (target: readonly unknown[] | null, hostId: string | null) =>
    scopedComposerTarget(target, hostId);
  const usageSubscriptions = new Map<
    string,
    { client: RendererModelClient; generation: number; dispose: () => void }
  >();
  let usageSubscriptionGeneration = 0;
  const localAgentForSidebarThread = (input: {
    hostId: string;
    threadId: string | null;
    draftId: string | null;
  }): RendererAgent | null => {
    for (const mounted of mountedByComposer.values()) {
      const target = mounted.modelTarget;
      const matchesDraft =
        target?.[0] === "default" && input.draftId !== null && target[1] === input.draftId;
      const matchesConversation =
        target?.[0] === "conversation" &&
        input.threadId !== null &&
        target[1] === input.threadId &&
        mounted.ownershipStatus === "ready";
      if (!matchesDraft && !matchesConversation) continue;
      if (input.hostId !== mounted.hostId || activeModelHostId(mounted.composer) !== input.hostId)
        continue;
      return controller.get(mounted.composer).agent;
    }
    return null;
  };
  const sidebarAgentIcons = installRendererSidebarAgentIcons({
    getClient: (hostId) => modelClientForHost(hostId),
    getPresentation: (hostId, agent) => hostHarnessAvailabilityState(hostId).descriptors.get(agent),
    getLocalAgent: localAgentForSidebarThread,
  });
  let connectionDiagnostics: RendererConnectionDiagnostics | null = null;
  const settingsLifecycle = installRendererSettingsLifecycle(window, {
    getUpdateClient: () => modelClientForHost("local"),
    getAccountClient: () => modelClientForHost("local"),
    getResourcesClient: () => {
      const list = modelClientForHost("local")?.listLoadedSessions;
      return list ? { listLoadedSessions: () => list() } : null;
    },
    getConnectionDiagnostics: () => connectionDiagnostics,
    getSessionImportClient: () => {
      const client = modelClientForHost("local");
      const sources = client?.listSessionImportSources;
      const list = client?.listHarnessSessions;
      const importSession = client?.importHarnessSession;
      if (!sources || !list || !importSession) return null;
      return {
        listSessionImportSources: () => sources(),
        listHarnessSessions: (input) => list(input),
        importHarnessSession: (input) => importSession(input),
      };
    },
    openImportedThread: (threadId, signal) =>
      openRendererThread(threadId, { hostId: "local", signal }),
    onLocaleChange() {
      for (const mounted of mountedByComposer.values()) renderMounted(mounted);
    },
  });
  let adapterStatus: RendererAdapterStatus = {
    state: "installing",
    reason: "installing",
    modelUpdates: 0,
    hook: null,
  };
  const createHostHarnessAvailabilityState = (): HostHarnessAvailabilityState => ({
    codexAccounts: null,
    directory: "unknown",
    descriptors: new Map(),
    availability: Object.fromEntries(
      externalAgents.map((agent) => [agent, "checking"]),
    ) as HarnessAvailability,
    errors: {},
    webUi: Object.fromEntries(
      externalAgents.map((agent) => [agent, false]),
    ) as HarnessWebUiAvailability,
    requestGeneration: 0,
    request: null,
    retryTimer: null,
    retryAttempt: 0,
  });
  const harnessAvailabilityByHost = new Map<string, HostHarnessAvailabilityState>();
  const hostHarnessAvailabilityState = (hostId: string): HostHarnessAvailabilityState => {
    let state = harnessAvailabilityByHost.get(hostId);
    if (!state) {
      state = createHostHarnessAvailabilityState();
      harnessAvailabilityByHost.set(hostId, state);
    }
    return state;
  };
  const codexAccountsForHost = (hostId: string | null): RendererCodexAccountState | null => {
    if (!hostId) return null;
    const client = modelClientForHost(hostId);
    if (!client) return null;
    const state = hostHarnessAvailabilityState(hostId);
    if (state.codexAccounts?.client !== client) {
      state.codexAccounts = new RendererCodexAccountState(client);
    }
    return state.codexAccounts;
  };
  const composerCodexAccounts = (composer: Element): RendererCodexAccountState | null =>
    codexAccountsForHost(mountedByComposer.get(composer)?.hostId ?? null);
  let activeAvailabilityHostId = "local";
  const activeHarnessAvailabilityState = (): HostHarnessAvailabilityState =>
    hostHarnessAvailabilityState(activeAvailabilityHostId);
  const enabledAgentsForHost = (hostId: string | null): RendererAgent[] => {
    const state = hostId ? hostHarnessAvailabilityState(hostId) : null;
    return state?.directory === "directory"
      ? ["codex", ...state.descriptors.keys()]
      : [...configuredEnabledAgents];
  };
  const mountedHostIds = (): Set<string> =>
    new Set(
      [...mountedByComposer.values()]
        .map((mounted) => mounted.hostId)
        .filter((hostId): hostId is string => hostId !== null),
    );
  const connectionListeners = new Set<() => void>();
  const publishConnectionStatus = (): void => {
    for (const listener of connectionListeners) listener();
  };
  const availabilityRetryDelays = [500, 1000, 2000, 4000, 8000] as const;
  const usageRefreshTimers = new Map<Element, number>();
  const usageRefreshAttempts = new Map<Element, number>();

  const isMountedComposer = (composer: Element): boolean =>
    composer.isConnected &&
    composer.matches(CODEX_COMPOSER_SELECTOR) &&
    mountedByComposer.has(composer);

  const isCurrentModelRequest = (mounted: MountedComposer, generation: number): boolean =>
    isMountedComposer(mounted.composer) &&
    mountedByComposer.get(mounted.composer) === mounted &&
    controller.isCurrentModelRequest(mounted.composer, generation);

  const isCurrentOwnershipRequest = (mounted: MountedComposer, generation: number): boolean =>
    mounted.composer.isConnected &&
    mountedByComposer.get(mounted.composer) === mounted &&
    controller.isCurrentOwnershipRequest(mounted.composer, generation);

  const notifySubmission = (composer: Element, trigger: SubmissionTrigger): void => {
    const accounts = composerCodexAccounts(composer);
    const state = controller.recordSubmission(
      composer,
      accounts?.selection.selectedAccountId ?? undefined,
    );
    if (state.agent === "codex" && accounts) accounts.overrideAccountId = null;
    writeNewThreadAgentPreference(state.agent);
    if (state.agent !== "codex") {
      const model = controller.modelForAgent(composer, state.agent);
      if (model) {
        writeNewThreadExternalConfigurationPreference(
          state.agent,
          model,
          controller.thinkingOptionForAgent(composer, state.agent),
          controller.permissionModeForAgent(composer, state.agent),
        );
      }
    }
    window.dispatchEvent(
      new CustomEvent("codexhost:renderer-submission", {
        detail: {
          composerId: state.composerId,
          agent: state.agent,
          trigger,
        },
      }),
    );
  };

  const renderMounted = (mounted: MountedComposer): void => {
    const state = controller.get(mounted.composer);
    const accounts = composerCodexAccounts(mounted.composer);
    const selectedCodexAccountId =
      state.phase === "locked" ||
      (controller.isSubmissionPending(mounted.composer) && state.codexAccountId)
        ? state.codexAccountId
        : accounts?.selection.selectedAccountId;
    renderComposerAgentControl(
      mounted.control,
      controller.get(mounted.composer),
      adapterStatus.state,
      accounts?.switching === true ||
        controller.isSwitching(mounted.composer) ||
        mounted.ownershipStatus === "loading",
      hostHarnessAvailabilityState(mounted.hostId ?? activeAvailabilityHostId).availability,
      mounted.modelView,
      mounted.permissionModeView,
      mounted.usage,
      mounted.accountCredits,
      settingsLifecycle.locale,
      (accounts?.accounts ?? []).map((account) => ({
        ...account,
        active: account.accountId === selectedCodexAccountId,
      })),
      mounted.ownershipStatus === "error",
    );
    if (mounted.control.usage) {
      mounted.control.usage.onOpen = () => {
        void refreshThreadUsage(
          mounted,
          controller.get(mounted.composer).agent === "codex" ? undefined : "exact",
        );
      };
    }
  };

  let delegationMention: RendererDelegationMentionControl | null = null;
  const draftWorkspaces = new Map<string, string>();
  {
    const published: unknown = Reflect.get(window, "__codexhostDraftWorkspacesV1");
    if (typeof published === "object" && published !== null) {
      for (const [hostId, cwd] of Object.entries(published)) {
        if (typeof cwd === "string" && cwd.length > 0) draftWorkspaces.set(hostId, cwd);
      }
    }
  }
  const refreshCommands = async (
    mounted: MountedComposer,
    { keepCurrent = false }: { keepCurrent?: boolean } = {},
  ): Promise<void> => {
    const generation = ++mounted.commandRequestGeneration;
    const agent = controller.get(mounted.composer).agent;
    const hostId = threadIdFromComposerModelTarget(mounted.modelTarget)
      ? mounted.hostId
      : activeModelHostId(mounted.composer);
    const cwd =
      hostId && !threadIdFromComposerModelTarget(mounted.modelTarget)
        ? draftWorkspaces.get(hostId)
        : undefined;
    const requestControl = modelControl;
    const client = modelClientForHostFrom(requestControl, hostId);
    const isCurrent = (): boolean =>
      !disposed &&
      mountedByComposer.get(mounted.composer) === mounted &&
      mounted.commandRequestGeneration === generation &&
      requestControl === modelControl &&
      (threadIdFromComposerModelTarget(mounted.modelTarget)
        ? mounted.hostId
        : activeModelHostId(mounted.composer)) === hostId &&
      (threadIdFromComposerModelTarget(mounted.modelTarget) || !hostId
        ? true
        : draftWorkspaces.get(hostId) === cwd) &&
      controller.get(mounted.composer).agent === agent;
    mounted.commandStatus = "loading";
    mounted.commandError = null;
    if (!keepCurrent || agent === "codex") mounted.control.harnessCommands.setCommands([]);
    if (agent === "codex" || !client) {
      mounted.commandStatus = agent === "codex" ? "idle" : "error";
      delegationMention?.refresh();
      return;
    }
    try {
      const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
      if (!threadId && cwd) {
        // An unscoped inspect returns built-ins immediately. The workspace
        // query may wait for native metadata, so keep those entries visible.
        try {
          const builtins = await client.inspectHarnessCommands({
            harnessId: harnessIdSchema.parse(agent),
          });
          if (!isCurrent()) return;
          mounted.control.harnessCommands.setCommands(builtins.commands, false, "static");
          delegationMention?.refresh();
        } catch {
          if (!isCurrent()) return;
          // The workspace query below still gets a chance to return a catalog.
        }
      }
      const catalog = threadId
        ? await client.inspectThreadCommands({
            threadId,
            ...(keepCurrent ? { refresh: true } : {}),
          })
        : await client.inspectHarnessCommands({
            harnessId: harnessIdSchema.parse(agent),
            ...(cwd ? { cwd } : {}),
            ...(keepCurrent ? { refresh: true } : {}),
          });
      if (!isCurrent()) return;
      mounted.control.harnessCommands.setCommands(
        catalog.commands,
        threadIdFromComposerModelTarget(mounted.modelTarget) !== null,
        catalog.source,
      );
      mounted.commandStatus = "ready";
      delegationMention?.refresh();
    } catch (error) {
      if (!isCurrent()) return;
      mounted.commandStatus = "error";
      mounted.commandError = error instanceof Error ? error.message : String(error);
      delegationMention?.refresh();
    }
  };

  const composerModelClient = (mounted: MountedComposer) => {
    const hostId = mounted.hostId;
    const client = hostId ? modelClientForHost(hostId) : null;
    if (!hostId || !client || activeModelHostId(mounted.composer) !== hostId) return null;
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    const sameTarget = () =>
      !disposed &&
      mountedByComposer.get(mounted.composer) === mounted &&
      mounted.composer.isConnected &&
      mounted.hostId === hostId &&
      activeModelHostId(mounted.composer) === hostId &&
      threadIdFromComposerModelTarget(mounted.modelTarget) === threadId;
    return {
      client,
      sameTarget,
      isCurrent: () => sameTarget() && modelClientForHost(hostId) === client,
      refreshIfReplaced: () => {
        if (sameTarget() && modelClientForHost(hostId) !== client) {
          void loadThreadOwnership(mounted);
        }
      },
    };
  };

  const executeCommand = async (
    mounted: MountedComposer,
    command: HarnessCommandDescriptor,
  ): Promise<void> => {
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    const route = composerModelClient(mounted);
    if (!threadId || !route || controller.get(mounted.composer).agent === "codex") return;
    mounted.control.harnessCommands.setExecuting(command.id);
    try {
      await route.client.executeThreadCommand({ threadId, commandId: command.id });
    } catch (error) {
      if (!route.isCurrent()) return;
      showComposerCommandError(
        mounted.composer,
        error instanceof Error ? error.message : String(error),
      );
      console.error(
        "codexhost Harness command failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (route.sameTarget()) mounted.control.harnessCommands.setExecuting(null);
    }
  };

  const selectCommand = (mounted: MountedComposer, command: HarnessCommandDescriptor): void => {
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    if (!modelControl || controller.get(mounted.composer).agent === "codex") return;
    if (
      mounted.commandStatus !== "ready" ||
      !mounted.control.harnessCommands
        .snapshot()
        .commands.some(
          (current) => current.id === command.id && current.invocation === command.invocation,
        )
    )
      return;
    if (!threadId && rendererHarnessCommandExecutesDirectly(command)) return;
    const editor = mounted.composer.querySelector<HTMLElement>(EDITOR_SELECTOR);
    if (
      routeRendererHarnessCommandSelection(editor, command, () => {
        void executeCommand(mounted, command);
      })
    ) {
      return;
    }
    console.error("codexhost Harness command could not claim the current Composer editor");
  };

  const applyThreadUsageUpdate = (update: ThreadUsageInspection, hostId: string | null): void => {
    if (!hostId) return;
    for (const mounted of mountedByComposer.values()) {
      if (mounted.hostId !== hostId) continue;
      if (activeModelHostId(mounted.composer) !== hostId) continue;
      if (threadIdFromComposerModelTarget(mounted.modelTarget) !== update.threadId) continue;
      mounted.usageRequestGeneration += 1;
      mounted.usage = update.usage;
      mounted.accountCredits = update.accountCredits ?? null;
      usageRefreshAttempts.delete(mounted.composer);
      renderMounted(mounted);
    }
  };

  const refreshUsageSubscriptions = (): void => {
    const hostIds = mountedHostIds();
    const activeHostId = modelControl?.currentHostId?.();
    if (activeHostId) hostIds.add(activeHostId);
    for (const [hostId, entry] of usageSubscriptions) {
      if (hostIds.has(hostId) && modelClientForHost(hostId) === entry.client) continue;
      usageSubscriptions.delete(hostId);
      entry.dispose();
    }
    for (const hostId of hostIds) {
      if (usageSubscriptions.has(hostId)) continue;
      const control = modelControl;
      const client = modelClientForHost(hostId);
      if (!control || !client?.subscribeThreadUsage) continue;
      const generation = ++usageSubscriptionGeneration;
      const entry: { client: RendererModelClient; generation: number; dispose: () => void } = {
        client,
        generation,
        dispose: () => undefined,
      };
      usageSubscriptions.set(hostId, entry);
      try {
        entry.dispose = client.subscribeThreadUsage((update) => {
          if (
            disposed ||
            modelControl !== control ||
            usageSubscriptions.get(hostId) !== entry ||
            usageSubscriptions.get(hostId)?.generation !== generation ||
            modelClientForHost(hostId) !== client
          ) {
            return;
          }
          applyThreadUsageUpdate(update, hostId);
        });
      } catch {
        usageSubscriptions.delete(hostId);
      }
    }
  };

  const refreshDraftCodexUsage = async (mounted: MountedComposer): Promise<void> => {
    const state = controller.get(mounted.composer);
    if (
      state.agent !== "codex" ||
      state.phase !== "draft" ||
      controller.isSubmissionPending(mounted.composer) ||
      threadIdFromComposerModelTarget(mounted.modelTarget)
    )
      return;
    const accounts = composerCodexAccounts(mounted.composer);
    const client = accounts?.client;
    const accountId = accounts?.selection.selectedAccountId;
    const hostId = mounted.hostId;
    const generation = ++mounted.usageRequestGeneration;
    mounted.usage = null;
    mounted.accountCredits = null;
    renderMounted(mounted);
    if (accounts?.switching || !accountId || !client?.inspectCodexAccountUsage) return;
    try {
      const result = await client.inspectCodexAccountUsage({ accountId });
      if (
        disposed ||
        mounted.hostId !== hostId ||
        composerCodexAccounts(mounted.composer) !== accounts ||
        !mounted.composer.isConnected ||
        mountedByComposer.get(mounted.composer) !== mounted ||
        mounted.usageRequestGeneration !== generation ||
        controller.get(mounted.composer).agent !== "codex" ||
        controller.get(mounted.composer).phase !== "draft" ||
        controller.isSubmissionPending(mounted.composer) ||
        threadIdFromComposerModelTarget(mounted.modelTarget) ||
        accounts.selection.selectedAccountId !== accountId ||
        result.accountId !== accountId
      )
        return;
      mounted.usage = result.usage;
      mounted.accountCredits = result.accountCredits ?? null;
      renderMounted(mounted);
    } catch {
      // Leave unknown quota empty instead of retaining a different Account's values.
    }
  };

  const refreshThreadUsage = async (mounted: MountedComposer, refresh?: "exact"): Promise<void> => {
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    if (!threadId && controller.get(mounted.composer).agent === "codex") {
      await refreshDraftCodexUsage(mounted);
      return;
    }
    const hostId = mounted.hostId;
    const client = hostId ? modelClientForHost(hostId) : null;
    if (!threadId || !hostId || !client) {
      mounted.usage = null;
      mounted.accountCredits = null;
      usageRefreshAttempts.delete(mounted.composer);
      renderMounted(mounted);
      return;
    }
    const generation = ++mounted.usageRequestGeneration;
    try {
      const result = await client.inspectThreadUsage({
        threadId,
        ...(refresh ? { refresh } : {}),
      });
      if (
        disposed ||
        mountedByComposer.get(mounted.composer) !== mounted ||
        !mounted.composer.isConnected ||
        mounted.usageRequestGeneration !== generation ||
        mounted.hostId !== hostId ||
        activeModelHostId(mounted.composer) !== hostId ||
        modelClientForHost(hostId) !== client ||
        threadIdFromComposerModelTarget(mounted.modelTarget) !== threadId ||
        result.threadId !== threadId
      ) {
        return;
      }
      mounted.usage = result.usage;
      mounted.accountCredits = result.accountCredits ?? null;
      const agent = controller.get(mounted.composer).agent;
      if (
        result.usage !== null &&
        (!externalAgentHasAccountCredits(agent) || result.accountCredits)
      ) {
        usageRefreshAttempts.delete(mounted.composer);
      }
      renderMounted(mounted);
      if (
        shouldRetryExternalThreadUsage(
          controller.get(mounted.composer).agent,
          result.usage,
          result.accountCredits ?? null,
        )
      ) {
        scheduleThreadUsageRefresh(mounted);
      }
    } catch (error) {
      if (
        mountedByComposer.get(mounted.composer) === mounted &&
        mounted.usageRequestGeneration === generation &&
        mounted.hostId === hostId &&
        activeModelHostId(mounted.composer) === hostId &&
        modelClientForHost(hostId) === client
      ) {
        renderMounted(mounted);
        if (
          !(error instanceof RendererMethodUnavailableError) &&
          shouldRetryExternalThreadUsage(controller.get(mounted.composer).agent, null, null)
        ) {
          scheduleThreadUsageRefresh(mounted);
        }
      }
    }
  };

  const scheduleThreadUsageRefresh = (mounted: MountedComposer): void => {
    if (usageRefreshTimers.has(mounted.composer)) return;
    const attempt = usageRefreshAttempts.get(mounted.composer) ?? 0;
    usageRefreshAttempts.set(mounted.composer, attempt + 1);
    const timer = window.setTimeout(() => {
      usageRefreshTimers.delete(mounted.composer);
      void refreshThreadUsage(mounted);
    }, rendererUsageRefreshDelay(attempt));
    usageRefreshTimers.set(mounted.composer, timer);
  };

  const isExternalConfigurationReady = (mounted: MountedComposer): boolean => {
    const current = controller.get(mounted.composer);
    if (current.agent === "codex") return true;
    return isExternalConfigurationReadyView(mounted.modelView, mounted.permissionModeView);
  };

  const policyForComposer = async (composer: Element): Promise<RendererDraftPrewarmPolicy> => {
    const routing = window.__codexhostHostRoutingV1;
    if (routing) {
      const policy = routing.forComposer(composer)?.policy;
      if (!policy) throw new Error("Renderer draft prewarm policy is unavailable");
      return policy;
    }
    return waitForRendererDraftPrewarmPolicy(window);
  };
  const clearDraftPrewarm = async (composer: Element): Promise<void> => {
    const policy = await policyForComposer(composer);
    await policy.clear();
  };

  const applyExternalConfiguration = (
    mounted: MountedComposer,
    agent: Exclude<RendererAgent, "codex">,
    model: HarnessModelRef | undefined,
    thinkingOptionId?: HarnessThinkingOptionId,
    permissionModeId?: HarnessPermissionModeId,
  ): boolean => {
    return applyComposerModelWrite(
      mounted.modelTarget,
      () =>
        applyAdapterAgent?.(agent, model, thinkingOptionId, permissionModeId, mounted.composer) ??
        false,
    );
  };

  const loadThreadOwnership = async (mounted: MountedComposer): Promise<void> => {
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    if (!threadId) {
      mounted.ownershipStatus = "not-required";
      return;
    }
    const requestModelControl = modelControl;
    const requestHostId = activeModelHostId(mounted.composer);
    const client = modelClientForHostFrom(requestModelControl, requestHostId);
    const generation = controller.beginOwnershipRequest(mounted.composer);
    const usageGeneration = mounted.usageRequestGeneration;
    mounted.ownershipStatus = "loading";
    renderMounted(mounted);
    try {
      if (!client || !requestHostId) throw new Error("Thread ownership control is unavailable");
      mounted.hostId = requestHostId;
      const inspection = await client.inspectThread({ threadId });
      if (
        !isCurrentOwnershipRequest(mounted, generation) ||
        mountedByComposer.get(mounted.composer) !== mounted ||
        threadIdFromComposerModelTarget(mounted.modelTarget) !== threadId ||
        mounted.hostId !== requestHostId ||
        modelControl !== requestModelControl ||
        activeModelHostId(mounted.composer) !== requestHostId
      ) {
        return;
      }
      const { agent, model, thinkingOptionId, permissionModeId } =
        restoredThreadOwnership(inspection);
      if (agent !== "codex" && !enabledAgentsForHost(requestHostId).includes(agent)) {
        await refreshHarnessAvailabilityForHost(requestHostId, false, false, true);
        const hostState = hostHarnessAvailabilityState(requestHostId);
        if (
          !isCurrentOwnershipRequest(mounted, generation) ||
          !enabledAgentsForHost(requestHostId).includes(agent) ||
          (hostState.directory === "directory" && !hostState.descriptors.has(agent))
        ) {
          throw new Error("External Thread Harness is unavailable on this Host");
        }
      }
      if (mounted.usageRequestGeneration === usageGeneration) {
        mounted.usage = inspection.owner === "external" ? (inspection.usage ?? null) : null;
      }
      const restored = controller.restore(
        mounted.composer,
        agent,
        model,
        thinkingOptionId,
        permissionModeId,
        inspection.owner === "codex" ? inspection.accountId : undefined,
      );
      if (!restored) {
        throw new Error("Thread owner could not be applied to the Composer");
      }
      mounted.ownershipStatus = "ready";
      if (agent !== "codex") {
        if (inspection.owner !== "external") {
          throw new Error("External Thread inspection did not include configuration");
        }
        mounted.threadConfiguration = {
          ...(inspection.effectiveModel ? { effectiveModel: inspection.effectiveModel } : {}),
          ...(inspection.resolvedModelLabel
            ? { resolvedModelLabel: inspection.resolvedModelLabel }
            : {}),
          ...(inspection.effectiveThinkingOptionId
            ? { effectiveThinkingOptionId: inspection.effectiveThinkingOptionId }
            : {}),
          ...(inspection.availableThinkingOptions
            ? { availableThinkingOptions: inspection.availableThinkingOptions }
            : {}),
          ...(inspection.effectivePermissionModeId
            ? { effectivePermissionModeId: inspection.effectivePermissionModeId }
            : {}),
        };
        mounted.modelView = { status: "loading" };
        mounted.permissionModeView = { status: "loading" };
        void loadExternalCatalog(mounted);
      } else {
        mounted.threadConfiguration = undefined;
        mounted.modelView = { status: "idle" };
        mounted.permissionModeView = { status: "idle" };
      }
    } catch {
      if (!isCurrentOwnershipRequest(mounted, generation)) return;
      mounted.ownershipStatus = "error";
    } finally {
      if (isCurrentOwnershipRequest(mounted, generation)) {
        renderMounted(mounted);
        if (mounted.ownershipStatus !== "error") void refreshCommands(mounted);
        sidebarAgentIcons.refresh();
        if (mounted.ownershipStatus !== "error") {
          const agent = controller.get(mounted.composer).agent;
          if (agent === "codex") {
            void refreshThreadUsage(mounted);
          } else if (shouldRetryExternalThreadUsage(agent, mounted.usage, mounted.accountCredits)) {
            scheduleThreadUsageRefresh(mounted);
          }
        }
      }
    }
  };

  const refreshMountedConversationTarget = (mounted: MountedComposer): boolean => {
    const currentTarget = findComposerModelTarget(mounted.composer);
    const resolution = lateConversationTargetResolution(
      mounted.modelTarget,
      currentTarget,
      controller.get(mounted.composer).phase,
      controller.isSubmissionPending(mounted.composer),
    );
    if (resolution === "none") return false;

    const previousTarget = mounted.modelTarget;
    const nextHostId = activeModelHostId(mounted.composer);
    if (!nextHostId) return false;
    const nextControllerTarget = controllerTarget(currentTarget, nextHostId);
    mounted.modelTarget = currentTarget;
    mounted.hostId = nextHostId;
    const rebound =
      resolution === "transfer"
        ? controller.transfer(mounted.composer, mounted.composer, nextControllerTarget)
        : controller.rebindConversation(mounted.composer, nextControllerTarget) !== null;
    if (!rebound) {
      mounted.ownershipStatus = "error";
      renderMounted(mounted);
      return true;
    }
    if (resolution === "transfer") {
      mounted.ownershipStatus = "ready";
      renderMounted(mounted);
      if (shouldRetryExternalThreadUsage(controller.get(mounted.composer).agent, null, null)) {
        scheduleThreadUsageRefresh(mounted);
      }
    } else {
      mounted.composerId = controller.get(mounted.composer).composerId;
      mounted.modelView = { status: "idle" };
      mounted.permissionModeView = { status: "idle" };
      mounted.threadConfiguration = undefined;
      mounted.ownershipStatus = "loading";
      mounted.usage = null;
      mounted.accountCredits = null;
      mounted.usageRequestGeneration += 1;
      usageRefreshAttempts.delete(mounted.composer);
      if (previousTarget?.[0] === "conversation") renderMounted(mounted);
      void loadThreadOwnership(mounted);
    }
    sidebarAgentIcons.refresh();
    return true;
  };

  const loadExternalCatalog = async (mounted: MountedComposer): Promise<void> => {
    void refreshCommands(mounted);
    const state = controller.get(mounted.composer);
    if (state.agent === "codex") return;
    const agent = state.agent;
    const requestModelControl = modelControl;
    const isDraft = !threadIdFromComposerModelTarget(mounted.modelTarget);
    const requestHostId = isDraft ? activeModelHostId(mounted.composer) : mounted.hostId;
    if (!requestHostId) {
      mounted.modelView = {
        status: "waitingForAdapter",
        thinkingSelectionSupported: false,
      };
      mounted.permissionModeView = { status: "idle" };
      renderMounted(mounted);
      return;
    }
    if (isDraft) mounted.hostId = requestHostId;
    const availability = hostHarnessAvailabilityState(requestHostId).availability[agent];
    if (availability !== "ready") {
      mounted.modelView = {
        status:
          adapterStatus.state !== "ready" || availability === "checking"
            ? "waitingForAdapter"
            : "error",
        thinkingSelectionSupported: false,
        ...(availability && availability !== "checking"
          ? { error: `${agent} runtime is ${availability}` }
          : {}),
      };
      mounted.permissionModeView = { status: "idle" };
      renderMounted(mounted);
      if (availability === "checking") void refreshHarnessAvailabilityForHost(requestHostId);
      return;
    }
    mounted.modelView = {
      status: adapterStatus.state === "ready" ? "loading" : "waitingForAdapter",
      thinkingSelectionSupported: false,
    };
    mounted.permissionModeView = { status: "idle" };
    renderMounted(mounted);
    if (adapterStatus.state !== "ready") return;
    const generation = controller.beginModelRequest(mounted.composer);
    try {
      if (!requestModelControl || !requestHostId) {
        throw new Error("External configuration control is unavailable");
      }
      const client = modelClientForHostFrom(requestModelControl, requestHostId);
      if (!client) {
        throw new Error(`Renderer Model request manager is unavailable for Host ${requestHostId}`);
      }
      const inspection = await client.inspectHarness({
        harnessId: harnessIdSchema.parse(agent),
      });
      if (
        !isCurrentModelRequest(mounted, generation) ||
        controller.get(mounted.composer).agent !== agent ||
        mounted.hostId !== requestHostId ||
        modelControl !== requestModelControl ||
        modelClientForHostFrom(requestModelControl, requestHostId) !== client ||
        activeModelHostId(mounted.composer) !== requestHostId
      ) {
        return;
      }
      if (inspection.status !== "ready") throw new Error(inspection.error.message);
      const current = controller.get(mounted.composer);
      const previousModel = controller.modelForAgent(mounted.composer, agent);
      const previousModelAvailable =
        previousModel !== undefined &&
        inspection.catalog.models.some((model) => model.ref.id === previousModel.id);
      const preferredConfiguration =
        current.phase === "draft" && !previousModelAvailable
          ? readNewThreadExternalConfigurationPreference(
              agent,
              inspection.catalog,
              inspection.permissionModes,
            )
          : undefined;
      const previousPermissionModeId = controller.permissionModeForAgent(mounted.composer, agent);
      const permissionModeLock = permissionModeSelectionLocked({
        phase: current.phase,
        permissionModeScope: inspection.capabilities.configuration.permissionModeScope,
      })
        ? {
            selectionLocked: true as const,
            selectionLockedReason: rendererHarnessMessages(settingsLifecycle.locale)
              .permissionModeFixedAtCreate,
          }
        : {};
      let selectedPermissionModeId: HarnessPermissionModeId | undefined;
      if (inspection.capabilities.configuration.selectPermissionMode) {
        const permissionModes = inspection.permissionModes;
        if (!permissionModes) {
          throw new Error("External Harness omitted its Permission Mode catalog");
        }
        mounted.permissionModeView = {
          status: "loading",
          catalog: permissionModes,
          ...permissionModeLock,
        };
        const restoredPermissionModeId =
          current.phase === "locked"
            ? lockedPermissionMode(
                permissionModes,
                mounted.threadConfiguration?.effectivePermissionModeId,
                previousPermissionModeId,
              )
            : undefined;
        const preferredPermissionModeId =
          preferredConfiguration?.permissionModeId ??
          (agent === "claude-code"
            ? readClaudePermissionModePreference(permissionModes)
            : undefined);
        selectedPermissionModeId = draftPermissionMode(
          permissionModes,
          restoredPermissionModeId ?? previousPermissionModeId ?? preferredPermissionModeId,
        );
        mounted.permissionModeView = {
          status: "loading",
          catalog: permissionModes,
          selected: selectedPermissionModeId,
          ...permissionModeLock,
        };
      } else {
        mounted.permissionModeView = { status: "unsupported" };
      }

      if (
        !inspection.capabilities.configuration.selectModel ||
        inspection.catalog.models.length === 0
      ) {
        mounted.modelView = {
          status: "empty",
          catalog: inspection.catalog,
          thinkingSelectionSupported: false,
        };
        if (current.phase === "draft") {
          if (
            !applyExternalConfiguration(
              mounted,
              agent,
              undefined,
              undefined,
              selectedPermissionModeId,
            )
          ) {
            throw new Error(
              "External fixed Model configuration could not be applied to the Composer",
            );
          }
          await clearDraftPrewarm(mounted.composer);
        }
        controller.setExternalThinkingOption(mounted.composer, agent, undefined);
        if (selectedPermissionModeId) {
          controller.setExternalPermissionMode(mounted.composer, agent, selectedPermissionModeId);
        }
        if (selectedPermissionModeId && mounted.permissionModeView.catalog) {
          mounted.permissionModeView = {
            status: "ready",
            catalog: mounted.permissionModeView.catalog,
            selected: selectedPermissionModeId,
            ...permissionModeLock,
          };
        }
        return;
      }
      if (current.phase === "locked" && previousModel && !previousModelAvailable) {
        mounted.modelView = {
          status: "error",
          catalog: inspection.catalog,
          selected: previousModel,
          thinkingSelectionSupported: inspection.capabilities.configuration.selectThinkingOption,
          error: "Existing Thread Model is absent from the current Catalog",
        };
        if (selectedPermissionModeId && mounted.permissionModeView.catalog) {
          mounted.permissionModeView = {
            status: "ready",
            catalog: mounted.permissionModeView.catalog,
            selected: selectedPermissionModeId,
            ...permissionModeLock,
          };
        }
        return;
      }

      const selected = previousModelAvailable
        ? previousModel
        : (preferredConfiguration?.model ?? inspection.catalog.defaultModel);
      if (!selected) throw new Error("External Harness did not report its default Model");
      const effectiveCatalog =
        current.phase === "locked" && mounted.threadConfiguration
          ? catalogWithConfigurationState(inspection.catalog, selected, mounted.threadConfiguration)
          : inspection.catalog;
      const previousThinkingOptionId = controller.thinkingOptionForAgent(mounted.composer, agent);
      const requestedThinkingOptionId = previousModelAvailable
        ? previousThinkingOptionId
        : preferredConfiguration?.thinkingOptionId;
      const selectedThinkingOptionId = inspection.capabilities.configuration.selectThinkingOption
        ? draftThinkingOptionForModel(effectiveCatalog, selected, requestedThinkingOptionId)
        : undefined;
      if (
        current.phase === "draft" &&
        (previousModel?.id !== selected.id ||
          previousThinkingOptionId !== selectedThinkingOptionId ||
          previousPermissionModeId !== selectedPermissionModeId)
      ) {
        if (
          !applyExternalConfiguration(
            mounted,
            agent,
            selected,
            selectedThinkingOptionId,
            selectedPermissionModeId,
          )
        ) {
          throw new Error("External configuration could not be applied to the Composer");
        }
        try {
          await clearDraftPrewarm(mounted.composer);
        } catch (error) {
          if (isCurrentModelRequest(mounted, generation)) {
            applyAdapterAgent?.(
              agent,
              previousModel,
              previousThinkingOptionId,
              previousPermissionModeId,
              mounted.composer,
            );
          }
          throw error;
        }
        if (!isCurrentModelRequest(mounted, generation)) return;
      }
      controller.setExternalModel(mounted.composer, agent, selected);
      controller.setExternalThinkingOption(mounted.composer, agent, selectedThinkingOptionId);
      if (selectedPermissionModeId) {
        controller.setExternalPermissionMode(mounted.composer, agent, selectedPermissionModeId);
      }
      mounted.modelView = {
        status: "ready",
        catalog: effectiveCatalog,
        selected,
        ...(selectedThinkingOptionId ? { selectedThinkingOptionId } : {}),
        ...(mounted.threadConfiguration?.resolvedModelLabel
          ? { resolvedModelLabel: mounted.threadConfiguration.resolvedModelLabel }
          : {}),
        thinkingSelectionSupported: inspection.capabilities.configuration.selectThinkingOption,
      };
      if (selectedPermissionModeId && mounted.permissionModeView.catalog) {
        mounted.permissionModeView = {
          status: "ready",
          catalog: mounted.permissionModeView.catalog,
          selected: selectedPermissionModeId,
          ...permissionModeLock,
        };
      }
    } catch (error) {
      if (!isCurrentModelRequest(mounted, generation)) return;
      const selected = controller.modelForAgent(mounted.composer, agent);
      const selectedThinkingOptionId = controller.thinkingOptionForAgent(mounted.composer, agent);
      const selectedPermissionModeId = controller.permissionModeForAgent(mounted.composer, agent);
      const message = error instanceof Error ? error.message : String(error);
      mounted.modelView = {
        status: "error",
        ...(mounted.modelView.catalog ? { catalog: mounted.modelView.catalog } : {}),
        ...(selected ? { selected } : {}),
        ...(selectedThinkingOptionId ? { selectedThinkingOptionId } : {}),
        thinkingSelectionSupported: false,
        error: message,
      };
      if (
        mounted.permissionModeView.status !== "unsupported" &&
        mounted.permissionModeView.status !== "idle"
      ) {
        mounted.permissionModeView = {
          status: "error",
          ...(mounted.permissionModeView.catalog
            ? { catalog: mounted.permissionModeView.catalog }
            : {}),
          ...(selectedPermissionModeId ? { selected: selectedPermissionModeId } : {}),
          error: message,
        };
      }
    } finally {
      if (isCurrentModelRequest(mounted, generation)) renderMounted(mounted);
    }
  };

  const selectExternalModel = async (mounted: MountedComposer, modelId: string): Promise<void> => {
    controller.clearPendingSubmission(mounted.composer);
    const route = composerModelClient(mounted);
    if (!route) return;
    const current = controller.get(mounted.composer);
    if (current.agent === "codex") return;
    const agent = current.agent;
    const catalog = mounted.modelView.catalog;
    const selected = catalog?.models.find((model) => model.ref.id === modelId)?.ref;
    if (!catalog || !selected || !modelControl) return;
    const previousModel = controller.modelForAgent(mounted.composer, agent);
    const previousThinking = controller.thinkingOptionForAgent(mounted.composer, agent);
    const previousPermissionModeId = controller.permissionModeForAgent(mounted.composer, agent);
    const supportsThinkingSelection = mounted.modelView.thinkingSelectionSupported === true;
    const generation = controller.beginModelRequest(mounted.composer);
    const isCurrent = () => route.isCurrent() && isCurrentModelRequest(mounted, generation);
    mounted.modelView = {
      status: "selecting",
      catalog,
      selected: previousModel ?? selected,
      ...(previousThinking ? { selectedThinkingOptionId: previousThinking } : {}),
      thinkingSelectionSupported: supportsThinkingSelection,
    };
    renderMounted(mounted);
    try {
      let effectiveModel: HarnessModelRef;
      let effectiveThinkingOptionId: HarnessThinkingOptionId | undefined;
      let effectiveCatalog: HarnessModelCatalog;
      let resolvedModelLabel: string | undefined;
      if (current.phase === "draft") {
        effectiveModel = selected;
        effectiveThinkingOptionId = supportsThinkingSelection
          ? draftThinkingOptionForModel(catalog, selected, previousThinking)
          : undefined;
        effectiveCatalog = catalog;
        if (
          !applyExternalConfiguration(
            mounted,
            agent,
            effectiveModel,
            effectiveThinkingOptionId,
            previousPermissionModeId,
          )
        ) {
          throw new Error("External Model configuration could not be applied to the Composer");
        }
        try {
          await clearDraftPrewarm(mounted.composer);
        } catch (error) {
          if (previousModel && isCurrent()) {
            applyExternalConfiguration(
              mounted,
              agent,
              previousModel,
              previousThinking,
              previousPermissionModeId,
            );
          }
          throw error;
        }
        if (!isCurrent()) return;
      } else {
        const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
        if (!threadId) {
          throw new Error("External Thread identity is unavailable for Model selection");
        }
        const state = await route.client.selectThreadModel({ threadId, model: selected });
        if (!isCurrent() || controller.get(mounted.composer).agent !== agent) {
          return;
        }
        if (!state.effectiveModel) {
          throw new Error("External Harness did not confirm an effective Model");
        }
        effectiveModel = state.effectiveModel;
        if (!catalog.models.some((model) => model.ref.id === effectiveModel.id)) {
          throw new Error("External Harness activated a Model outside the current catalog");
        }
        effectiveThinkingOptionId = supportsThinkingSelection
          ? selectableThinkingOptionId(state)
          : undefined;
        effectiveCatalog = supportsThinkingSelection
          ? catalogWithConfigurationState(catalog, effectiveModel, state)
          : catalog;
        resolvedModelLabel = state.resolvedModelLabel;
        const effectivePermissionModeId =
          state.effectivePermissionModeId ?? previousPermissionModeId;
        if (
          !applyExternalConfiguration(
            mounted,
            agent,
            effectiveModel,
            effectiveThinkingOptionId,
            effectivePermissionModeId,
          )
        ) {
          throw new Error("Confirmed external Model could not be applied to the Composer");
        }
        mounted.threadConfiguration = state;
      }
      if (!isCurrent()) return;
      controller.setExternalModel(mounted.composer, agent, effectiveModel);
      controller.setExternalThinkingOption(mounted.composer, agent, effectiveThinkingOptionId);
      const effectivePermissionModeId =
        mounted.threadConfiguration?.effectivePermissionModeId ?? previousPermissionModeId;
      if (effectivePermissionModeId) {
        controller.setExternalPermissionMode(mounted.composer, agent, effectivePermissionModeId);
      }
      if (shouldPersistNewThreadConfigurationSelection(current.phase)) {
        writeNewThreadExternalConfigurationPreference(
          agent,
          effectiveModel,
          effectiveThinkingOptionId,
          effectivePermissionModeId,
        );
      }
      mounted.modelView = {
        status: "ready",
        catalog: effectiveCatalog,
        selected: effectiveModel,
        ...(effectiveThinkingOptionId
          ? { selectedThinkingOptionId: effectiveThinkingOptionId }
          : {}),
        ...(resolvedModelLabel ? { resolvedModelLabel } : {}),
        thinkingSelectionSupported: supportsThinkingSelection,
      };
    } catch (error) {
      if (!isCurrent()) return;
      if (previousModel) {
        applyExternalConfiguration(
          mounted,
          agent,
          previousModel,
          previousThinking,
          previousPermissionModeId,
        );
      }
      mounted.modelView = {
        status: "error",
        catalog,
        ...(previousModel ? { selected: previousModel } : {}),
        ...(previousThinking ? { selectedThinkingOptionId: previousThinking } : {}),
        thinkingSelectionSupported: supportsThinkingSelection,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (isCurrent()) renderMounted(mounted);
      else if (isCurrentModelRequest(mounted, generation)) route.refreshIfReplaced();
    }
  };

  const selectPermissionMode = async (
    mounted: MountedComposer,
    permissionModeId: string,
  ): Promise<void> => {
    controller.clearPendingSubmission(mounted.composer);
    const route = composerModelClient(mounted);
    if (!route) return;
    const current = controller.get(mounted.composer);
    if (current.agent === "codex") return;
    const agent = current.agent;
    const catalog = mounted.permissionModeView.catalog;
    const selectedPermissionModeId = catalog?.modes.find(({ id }) => id === permissionModeId)?.id;
    const model = controller.modelForAgent(mounted.composer, agent);
    if (
      !catalog ||
      !selectedPermissionModeId ||
      !model ||
      !modelControl ||
      mounted.permissionModeView.selectionLocked
    ) {
      return;
    }
    const previousPermissionModeId = controller.permissionModeForAgent(mounted.composer, agent);
    const thinkingOptionId = controller.thinkingOptionForAgent(mounted.composer, agent);
    const generation = controller.beginModelRequest(mounted.composer);
    const isCurrent = () => route.isCurrent() && isCurrentModelRequest(mounted, generation);
    mounted.permissionModeView = {
      status: "selecting",
      catalog,
      selected: previousPermissionModeId ?? selectedPermissionModeId,
    };
    renderMounted(mounted);
    try {
      let effectivePermissionModeId = selectedPermissionModeId;
      if (current.phase === "draft") {
        if (
          !applyExternalConfiguration(
            mounted,
            agent,
            model,
            thinkingOptionId,
            selectedPermissionModeId,
          )
        ) {
          throw new Error("Permission Mode could not be applied to the Composer");
        }
        try {
          await clearDraftPrewarm(mounted.composer);
        } catch (error) {
          if (isCurrent()) {
            applyExternalConfiguration(
              mounted,
              agent,
              model,
              thinkingOptionId,
              previousPermissionModeId,
            );
          }
          throw error;
        }
        if (!isCurrent()) return;
      } else {
        const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
        if (!threadId) {
          throw new Error("External Thread identity is unavailable for Permission Mode selection");
        }
        const state = await route.client.selectThreadPermissionMode({
          threadId,
          permissionModeId: selectedPermissionModeId,
        });
        if (!isCurrent() || controller.get(mounted.composer).agent !== agent) {
          return;
        }
        if (
          !state.effectivePermissionModeId ||
          !catalog.modes.some(({ id }) => id === state.effectivePermissionModeId)
        ) {
          throw new Error("External Harness did not report a selectable Permission Mode");
        }
        effectivePermissionModeId = state.effectivePermissionModeId;
        if (
          !applyExternalConfiguration(
            mounted,
            agent,
            model,
            thinkingOptionId,
            effectivePermissionModeId,
          )
        ) {
          throw new Error("Confirmed Permission Mode could not be applied to the Composer");
        }
        mounted.threadConfiguration = state;
      }
      if (!isCurrent()) return;
      controller.setExternalPermissionMode(mounted.composer, agent, effectivePermissionModeId);
      if (shouldPersistNewThreadConfigurationSelection(current.phase)) {
        writeNewThreadExternalConfigurationPreference(
          agent,
          model,
          thinkingOptionId,
          effectivePermissionModeId,
        );
        if (agent === "claude-code") {
          writeClaudePermissionModePreference(effectivePermissionModeId);
        }
      }
      mounted.permissionModeView = {
        status: "ready",
        catalog,
        selected: effectivePermissionModeId,
      };
    } catch (error) {
      if (!isCurrent()) return;
      if (previousPermissionModeId) {
        applyExternalConfiguration(
          mounted,
          agent,
          model,
          thinkingOptionId,
          previousPermissionModeId,
        );
      }
      mounted.permissionModeView = {
        status: "error",
        catalog,
        ...(previousPermissionModeId ? { selected: previousPermissionModeId } : {}),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (isCurrent()) renderMounted(mounted);
      else if (isCurrentModelRequest(mounted, generation)) route.refreshIfReplaced();
    }
  };

  const selectExternalThinking = async (
    mounted: MountedComposer,
    thinkingOptionId: string,
  ): Promise<void> => {
    controller.clearPendingSubmission(mounted.composer);
    const route = composerModelClient(mounted);
    if (!route) return;
    const current = controller.get(mounted.composer);
    if (current.agent === "codex") return;
    const agent = current.agent;
    const catalog = mounted.modelView.catalog;
    const model = controller.modelForAgent(mounted.composer, agent);
    const permissionModeId = controller.permissionModeForAgent(mounted.composer, agent);
    const selectedThinkingOptionId = catalog?.thinkingOptions.find(
      ({ id }) => id === thinkingOptionId,
    )?.id;
    const catalogModel = catalog?.models.find((candidate) => candidate.ref.id === model?.id);
    if (
      !mounted.modelView.thinkingSelectionSupported ||
      !catalog ||
      !model ||
      !selectedThinkingOptionId ||
      !catalogModel?.supportedThinkingOptionIds?.includes(selectedThinkingOptionId)
    ) {
      return;
    }
    const previousThinking = controller.thinkingOptionForAgent(mounted.composer, agent);
    const generation = controller.beginModelRequest(mounted.composer);
    const isCurrent = () => route.isCurrent() && isCurrentModelRequest(mounted, generation);
    mounted.modelView = {
      status: "selecting",
      catalog,
      selected: model,
      ...(previousThinking ? { selectedThinkingOptionId: previousThinking } : {}),
      thinkingSelectionSupported: true,
    };
    renderMounted(mounted);
    try {
      let effectiveThinkingOptionId = selectedThinkingOptionId;
      let effectiveCatalog = catalog;
      if (current.phase === "draft") {
        if (
          !applyExternalConfiguration(
            mounted,
            agent,
            model,
            selectedThinkingOptionId,
            permissionModeId,
          )
        ) {
          throw new Error("External Thinking could not be applied to the Composer");
        }
        try {
          await clearDraftPrewarm(mounted.composer);
        } catch (error) {
          if (isCurrent()) {
            applyExternalConfiguration(mounted, agent, model, previousThinking, permissionModeId);
          }
          throw error;
        }
        if (!isCurrent()) return;
      } else {
        const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
        if (!threadId || !modelControl) {
          throw new Error("External Thread identity is unavailable for Thinking selection");
        }
        const state = await route.client.selectThreadThinking({
          threadId,
          thinkingOptionId: selectedThinkingOptionId,
        });
        if (!isCurrent() || controller.get(mounted.composer).agent !== agent) {
          return;
        }
        if (state.effectiveModel && state.effectiveModel.id !== model.id) {
          throw new Error("External Harness changed Model during Thinking selection");
        }
        if (!state.effectiveThinkingOptionId) {
          throw new Error("External Harness did not confirm effective Thinking");
        }
        effectiveThinkingOptionId = state.effectiveThinkingOptionId;
        effectiveCatalog = catalogWithConfigurationState(catalog, model, state);
        if (
          !applyExternalConfiguration(
            mounted,
            agent,
            model,
            effectiveThinkingOptionId,
            state.effectivePermissionModeId ?? permissionModeId,
          )
        ) {
          throw new Error("Confirmed external Thinking could not be applied to the Composer");
        }
        mounted.threadConfiguration = state;
      }
      if (!isCurrent()) return;
      controller.setExternalThinkingOption(mounted.composer, agent, effectiveThinkingOptionId);
      const effectivePermissionModeId =
        mounted.threadConfiguration?.effectivePermissionModeId ?? permissionModeId;
      if (effectivePermissionModeId) {
        controller.setExternalPermissionMode(mounted.composer, agent, effectivePermissionModeId);
      }
      if (shouldPersistNewThreadConfigurationSelection(current.phase)) {
        writeNewThreadExternalConfigurationPreference(
          agent,
          model,
          effectiveThinkingOptionId,
          effectivePermissionModeId,
        );
      }
      mounted.modelView = {
        status: "ready",
        catalog: effectiveCatalog,
        selected: model,
        selectedThinkingOptionId: effectiveThinkingOptionId,
        thinkingSelectionSupported: true,
      };
    } catch (error) {
      if (!isCurrent()) return;
      applyExternalConfiguration(mounted, agent, model, previousThinking, permissionModeId);
      mounted.modelView = {
        status: "error",
        catalog,
        selected: model,
        ...(previousThinking ? { selectedThinkingOptionId: previousThinking } : {}),
        thinkingSelectionSupported: true,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (isCurrent()) renderMounted(mounted);
      else if (isCurrentModelRequest(mounted, generation)) route.refreshIfReplaced();
    }
  };

  const switchComposerAgent = async (
    mounted: MountedComposer,
    agent: RendererAgent,
  ): Promise<boolean> => {
    if (
      agent !== "codex" &&
      hostHarnessAvailabilityState(mounted.hostId ?? activeAvailabilityHostId).availability[
        agent
      ] !== "ready"
    ) {
      return false;
    }
    controller.clearPendingSubmission(mounted.composer);
    const composerId = controller.get(mounted.composer).composerId;
    controller.invalidateModelRequests(mounted.composer);
    const switching = controller.switchAgent(mounted.composer, agent, {
      applyAgent(nextAgent) {
        const model = controller.modelForAgent(mounted.composer, nextAgent);
        if (!shouldApplyDraftAgentCarrier(nextAgent)) return true;
        return (
          applyAdapterAgent?.(
            nextAgent,
            model,
            nextAgent !== "codex"
              ? controller.thinkingOptionForAgent(mounted.composer, nextAgent)
              : undefined,
            nextAgent !== "codex"
              ? controller.permissionModeForAgent(mounted.composer, nextAgent)
              : undefined,
            mounted.composer,
          ) ?? nextAgent === "codex"
        );
      },
      clearPrewarm: () => clearDraftPrewarm(mounted.composer),
    });
    renderMounted(mounted);
    try {
      const switched = await switching;
      if (switched && controller.get(mounted.composer).agent !== "codex") {
        void loadExternalCatalog(mounted);
      } else if (controller.get(mounted.composer).agent === "codex") {
        mounted.modelView = { status: "idle" };
        mounted.permissionModeView = { status: "idle" };
        void refreshCommands(mounted);
      }
      sidebarAgentIcons.refresh();
      return switched;
    } catch {
      adapterStatus = {
        ...adapterStatus,
        state: "unsupported",
        reason: "draft-prewarm-clear-failed",
        hook: null,
      };
      return false;
    } finally {
      for (const candidate of mountedByComposer.values()) {
        if (controller.get(candidate.composer).composerId === composerId) renderMounted(candidate);
      }
    }
  };

  const loadCodexAccounts = async (): Promise<void> => {
    const hostId = activeModelHostId();
    const accounts = codexAccountsForHost(hostId);
    if (!accounts) return;
    await accounts.refresh();
    if (disposed || codexAccountsForHost(hostId) !== accounts) return;
    for (const mounted of mountedByComposer.values()) {
      if (mounted.hostId !== hostId) continue;
      renderMounted(mounted);
      void refreshDraftCodexUsage(mounted);
    }
  };

  const selectCodexAccount = async (mounted: MountedComposer, accountId: string): Promise<void> => {
    const hostId = mounted.hostId;
    const accounts = composerCodexAccounts(mounted.composer);
    if (
      !accounts ||
      accounts.switching ||
      controller.get(mounted.composer).phase === "locked" ||
      !accounts.accounts.some((account) => account.accountId === accountId)
    )
      return;
    const isCurrent = (): boolean =>
      !disposed &&
      mounted.composer.isConnected &&
      mountedByComposer.get(mounted.composer) === mounted &&
      controller.get(mounted.composer).phase !== "locked" &&
      accounts.accounts.some((account) => account.accountId === accountId) &&
      mounted.hostId === hostId &&
      activeModelHostId(mounted.composer) === hostId &&
      composerCodexAccounts(mounted.composer) === accounts;
    accounts.switching = true;
    for (const candidate of mountedByComposer.values()) {
      renderMounted(candidate);
      void refreshDraftCodexUsage(candidate);
    }
    try {
      if (
        controller.get(mounted.composer).agent !== "codex" &&
        !(await switchComposerAgent(mounted, "codex"))
      ) {
        return;
      }
      const policy = await policyForComposer(mounted.composer);
      if (!isCurrent() || policy.hostId !== hostId) return;
      await policy.clear();
      if (!isCurrent() || (await policyForComposer(mounted.composer)) !== policy) return;
      if (!policy.selectAccount) throw new Error("Codex Account selection is unavailable");
      const override = accountId === accounts.selection.activeAccountId ? null : accountId;
      policy.selectAccount(override);
      accounts.overrideAccountId = override;
    } catch {
      if (isCurrent()) void loadCodexAccounts();
    } finally {
      accounts.switching = false;
      for (const candidate of mountedByComposer.values()) {
        renderMounted(candidate);
        void refreshDraftCodexUsage(candidate);
      }
    }
  };

  const openInstallPage = (agent: ExternalRendererAgent, hostId: string | null): void => {
    const descriptor = hostHarnessAvailabilityState(
      hostId ?? activeAvailabilityHostId,
    ).descriptors.get(agent);
    const url = descriptor?.links?.installation ?? RENDERER_AGENT_INSTALL_URLS[agent];
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  const synchronizeActiveDirectoryAgents = (hostId: string): void => {
    const state = hostHarnessAvailabilityState(hostId);
    const next = [
      ...new Set(
        [...harnessAvailabilityByHost.keys()].flatMap((candidate) =>
          enabledAgentsForHost(candidate),
        ),
      ),
    ];
    const changed =
      next.length !== enabledAgents.length ||
      next.some((agent, index) => enabledAgents[index] !== agent);
    if (changed) {
      enabledAgents = next;
      controller.setEnabledAgents(next);
    }
    const presentations = presentationsForHostState(state);
    for (const mounted of mountedByComposer.values()) {
      if (mounted.hostId !== hostId) continue;
      const hostAgents = enabledAgentsForHost(hostId);
      const pickerChanged =
        mounted.control.picker.agents.length !== hostAgents.length ||
        mounted.control.picker.agents.some((candidate, index) => candidate !== hostAgents[index]);
      if (pickerChanged) {
        replaceComposerAgentPicker(
          mounted.control,
          hostAgents,
          (agent) => {
            const current = mountedByComposer.get(mounted.composer);
            if (current) void switchComposerAgent(current, agent);
          },
          (agent) => openInstallPage(agent, mounted.hostId),
          async (accountId) => {
            const current = mountedByComposer.get(mounted.composer);
            if (current) await selectCodexAccount(current, accountId);
          },
          () => {
            void loadCodexAccounts();
          },
          presentations,
        );
      } else {
        mounted.control.picker.presentations = presentations;
      }
      renderMounted(mounted);
    }
  };

  function resetHarnessAvailabilityRetry(hostId: string): void {
    const state = hostHarnessAvailabilityState(hostId);
    if (state.retryTimer !== null) {
      window.clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.retryAttempt = 0;
  }

  function scheduleHarnessAvailabilityRetry(hostId: string): void {
    const state = hostHarnessAvailabilityState(hostId);
    if (
      disposed ||
      state.retryTimer !== null ||
      state.retryAttempt >= availabilityRetryDelays.length
    ) {
      return;
    }
    const delay = availabilityRetryDelays[state.retryAttempt];
    state.retryAttempt += 1;
    state.retryTimer = window.setTimeout(() => {
      state.retryTimer = null;
      void refreshHarnessAvailabilityForHost(hostId, true, true);
    }, delay);
  }

  function modelClientForHostFrom(
    control: RendererModelClient | null,
    hostId: string | null,
  ): RendererModelClient | null {
    if (!control || !hostId) return null;
    const selected = control.clientForHost?.(hostId);
    if (selected) return selected;
    const currentHostId = control.currentHostId?.() ?? "local";
    return currentHostId === hostId ? control : null;
  }

  function modelClientForHost(hostId: string): RendererModelClient | null {
    return modelClientForHostFrom(modelControl, hostId);
  }

  function refreshHarnessAvailabilityForHost(
    hostId: string,
    refresh = false,
    retry = false,
    force = false,
  ): Promise<void> {
    const state = hostHarnessAvailabilityState(hostId);
    if (!retry) resetHarnessAvailabilityRetry(hostId);
    const client = modelClientForHost(hostId);
    if (!client) {
      scheduleHarnessAvailabilityRetry(hostId);
      return Promise.resolve();
    }
    if (state.request?.client === client) return state.request.promise;
    const generation = ++state.requestGeneration;
    const promise = (async () => {
      if (state.directory !== "legacy" || force) {
        const listHarnessPlugins = client.listHarnessPlugins;
        if (!listHarnessPlugins) {
          if (generation !== state.requestGeneration || disposed) return;
          state.directory = "legacy";
          state.descriptors = new Map();
          synchronizeActiveDirectoryAgents(hostId);
        } else {
          try {
            const directory = await listHarnessPlugins();
            if (!directory) {
              if (generation !== state.requestGeneration || disposed) return;
              state.directory = "legacy";
              state.descriptors = new Map();
              synchronizeActiveDirectoryAgents(hostId);
            } else {
              if (generation !== state.requestGeneration || disposed) return;
              state.directory = "directory";
              state.descriptors = new Map(directory.plugins.map((plugin) => [plugin.id, plugin]));
              synchronizeActiveDirectoryAgents(hostId);
            }
          } catch (error) {
            if (!(error instanceof RendererMethodUnavailableError)) throw error;
            if (generation !== state.requestGeneration || disposed) return;
            state.directory = "legacy";
            state.descriptors = new Map();
            synchronizeActiveDirectoryAgents(hostId);
          }
        }
      }
      const hostAgents = agentsForHostState(state);
      const agentsToInspect = force
        ? hostAgents
        : passiveHarnessAvailabilityAgents(state.availability, state.errors, hostAgents);
      if (agentsToInspect.length === 0) {
        resetHarnessAvailabilityRetry(hostId);
        return;
      }
      const nextAvailability = { ...state.availability };
      for (const agent of agentsToInspect) {
        nextAvailability[agent] = harnessAvailabilityDuringInspect(nextAvailability[agent]);
      }
      state.availability = nextAvailability;
      publishConnectionStatus();
      for (const mounted of mountedByComposer.values()) {
        if (mounted.hostId === hostId) renderMounted(mounted);
      }
      const inspectAgent = async (agent: ExternalRendererAgent): Promise<void> => {
        let status: RendererAgentAvailability = "error";
        let nextError: CodexhostError | undefined;
        let webUiAvailable = false;
        try {
          const inspection = await client.inspectHarness({
            harnessId: harnessIdSchema.parse(agent),
            refresh,
          });
          status = inspection.status === "ready" ? "ready" : inspection.status;
          webUiAvailable =
            hostId === "local" && inspection.status === "ready" && inspection.webUi?.open === true;
          if (inspection.status !== "ready") {
            const error = inspection.error;
            nextError = {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
              ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
              ...(error.stage ? { stage: error.stage } : {}),
              ...(error.durationMs !== undefined ? { durationMs: error.durationMs } : {}),
              ...(error.stderrTail ? { stderrTail: error.stderrTail } : {}),
            };
          }
        } catch (error) {
          status = "error";
          nextError = {
            code: "internalError",
            message: error instanceof Error ? error.message : String(error),
            retryable: !(error instanceof RendererMethodUnavailableError),
            stage: "request",
          };
        }
        if (generation !== state.requestGeneration || disposed) return;
        const previousStatus = state.availability[agent];
        state.errors[agent] = nextError;
        state.availability = { ...state.availability, [agent]: status };
        state.webUi = { ...state.webUi, [agent]: webUiAvailable };
        for (const mounted of mountedByComposer.values()) {
          if (mounted.hostId !== hostId) continue;
          const composerState = controller.get(mounted.composer);
          if (
            adapterStatus.state === "ready" &&
            composerState.phase === "draft" &&
            composerState.agent === agent &&
            status !== "ready"
          ) {
            await switchComposerAgent(mounted, "codex");
          }
        }
        for (const mounted of mountedByComposer.values()) {
          if (mounted.hostId !== hostId) continue;
          const composerState = controller.get(mounted.composer);
          if (
            composerState.agent === agent &&
            shouldReloadExternalCatalogAfterAvailabilityRefresh(
              previousStatus,
              status,
              isExternalConfigurationStable(mounted.modelView, mounted.permissionModeView),
              refresh && force,
            )
          ) {
            void loadExternalCatalog(mounted);
          }
          renderMounted(mounted);
        }
        publishConnectionStatus();
        delegationMention?.refresh();
      };
      // This fork has no request priority contract. Finish the current
      // Composer's inspection before starting optional directory inspections.
      const selectedAgents = new Set(
        [...mountedByComposer.values()]
          .filter((mounted) => mounted.hostId === hostId)
          .map((mounted) => controller.get(mounted.composer).agent),
      );
      const current = agentsToInspect.filter((agent) => selectedAgents.has(agent));
      await Promise.all(current.map(inspectAgent));
      if (generation !== state.requestGeneration || disposed) return;
      await Promise.all(
        agentsToInspect.filter((agent) => !selectedAgents.has(agent)).map(inspectAgent),
      );
      if (generation !== state.requestGeneration || disposed) return;
      if (
        retryableHarnessAvailabilityAgents(
          state.availability,
          state.errors,
          agentsForHostState(state),
        ).length === 0
      ) {
        resetHarnessAvailabilityRetry(hostId);
      } else {
        scheduleHarnessAvailabilityRetry(hostId);
      }
    })();
    const request = { client, promise };
    state.request = request;
    void promise.then(
      () => {
        if (state.request === request) state.request = null;
      },
      () => {
        if (state.request === request) state.request = null;
      },
    );
    return promise;
  }

  const reloadMountedOwnershipForHost = (): void => {
    const changedHosts = new Set<string>();
    for (const mounted of mountedByComposer.values()) {
      const resolvedHostId = activeModelHostId(mounted.composer);
      if (!resolvedHostId || mounted.hostId === resolvedHostId) continue;
      if (!threadIdFromComposerModelTarget(mounted.modelTarget)) {
        controller.clearPendingSubmission(mounted.composer);
        mounted.hostId = resolvedHostId;
        changedHosts.add(resolvedHostId);
        mounted.usage = null;
        mounted.accountCredits = null;
        mounted.usageRequestGeneration += 1;
        continue;
      }
      const target = controllerTarget(mounted.modelTarget, resolvedHostId);
      if (controller.rebindConversation(mounted.composer, target) === null) {
        mounted.ownershipStatus = "error";
        renderMounted(mounted);
        continue;
      }
      mounted.hostId = resolvedHostId;
      changedHosts.add(resolvedHostId);
      mounted.composerId = controller.get(mounted.composer).composerId;
      mounted.modelView = { status: "idle" };
      mounted.permissionModeView = { status: "idle" };
      mounted.threadConfiguration = undefined;
      mounted.ownershipStatus = "loading";
      mounted.usage = null;
      mounted.accountCredits = null;
      mounted.usageRequestGeneration += 1;
      usageRefreshAttempts.delete(mounted.composer);
      const timer = usageRefreshTimers.get(mounted.composer);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        usageRefreshTimers.delete(mounted.composer);
      }
      renderMounted(mounted);
      void loadThreadOwnership(mounted);
    }
    for (const hostId of changedHosts) synchronizeActiveDirectoryAgents(hostId);
    sidebarAgentIcons.refresh();
  };

  function reconcileHarnessAvailabilityHost(): void {
    const hostId = activeModelHostId();
    if (
      !hostId ||
      (hostId === activeAvailabilityHostId &&
        [...mountedByComposer.values()].every(
          (mounted) => mounted.hostId === activeModelHostId(mounted.composer),
        ))
    )
      return;
    // The first Composer can mount before the route is ready. The availability
    // cache starts at "local", but that does not establish the Composer's Host.
    activeAvailabilityHostId = hostId;
    hostHarnessAvailabilityState(hostId);
    reloadMountedOwnershipForHost();
    publishConnectionStatus();
    for (const mounted of mountedByComposer.values()) renderMounted(mounted);
    void refreshHarnessAvailabilityForHost(hostId);
  }

  const refreshHarnessAvailability = (refresh = false): Promise<void> => {
    reconcileHarnessAvailabilityHost();
    return refreshHarnessAvailabilityForHost(activeAvailabilityHostId, refresh);
  };

  connectionDiagnostics = {
    snapshot(): RendererConnectionSnapshot {
      const hostIds = [
        "local",
        ...[...harnessAvailabilityByHost.keys()].filter((hostId) => hostId !== "local").sort(),
      ];
      return {
        adapter: { ...adapterStatus },
        hosts: hostIds.map((hostId) => {
          const state = hostHarnessAvailabilityState(hostId);
          return {
            hostId,
            active: hostId === activeAvailabilityHostId,
            agents: agentsForHostState(state).map((agent) => {
              const descriptor = state.descriptors.get(agent);
              return {
                agent,
                ...(descriptor ? { name: descriptor.name } : {}),
                ...(descriptor?.icon ? { icon: descriptor.icon } : {}),
                ...(descriptor?.links?.installation
                  ? { installationUrl: descriptor.links.installation }
                  : {}),
                availability: state.availability[agent] ?? "checking",
                error: state.errors[agent] ?? null,
                ...(state.webUi[agent] ? { webUiAvailable: true as const } : {}),
              };
            }),
          };
        }),
      };
    },
    refresh(): Promise<void> {
      return refreshConnectionHosts(harnessAvailabilityByHost.keys(), (hostId) =>
        refreshHarnessAvailabilityForHost(hostId, true, false, true),
      );
    },
    async openWebUi(hostId: string, agent: ExternalRendererAgent): Promise<void> {
      const state = hostHarnessAvailabilityState(hostId);
      const client = hostId === "local" ? modelClientForHost(hostId) : null;
      if (
        state.availability[agent] !== "ready" ||
        state.webUi[agent] !== true ||
        !client?.openHarnessWebUi
      ) {
        throw new Error("Harness Web UI is unavailable");
      }
      try {
        await client.openHarnessWebUi({ harnessId: harnessIdSchema.parse(agent) });
      } catch (error) {
        state.webUi = { ...state.webUi, [agent]: false };
        publishConnectionStatus();
        void refreshHarnessAvailabilityForHost(hostId, true, false, true).catch(() => undefined);
        throw error;
      }
    },
    subscribe(listener: () => void): () => void {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
  };

  const mount = (composer: Element): void => {
    if (
      mountedByComposer.has(composer) ||
      !composer.isConnected ||
      !composer.matches(CODEX_COMPOSER_SELECTOR)
    ) {
      return;
    }
    const allButtons = [...composer.querySelectorAll<HTMLButtonElement>("button")];
    const sendButton = sendButtonWithin(composer) ?? allButtons.at(-1) ?? null;
    if (!sendButton) return;
    const modelTarget = findComposerModelTarget(composer);
    const hostId = activeModelHostId(composer);
    const editor = composer.querySelector<HTMLElement>(EDITOR_SELECTOR);
    if (!editor) return;
    const state = controller.mount(
      composer,
      controllerTarget(modelTarget, hostId),
      modelTarget?.[0] === "default"
        ? readNewThreadAgentPreference(new Set(enabledAgentsForHost(hostId)))
        : undefined,
    );
    const inherited = pendingReplacements.get(composer)?.source;
    const control = mountComposerAgentControl(
      composer,
      state.composerId,
      sendButton,
      enabledAgentsForHost(hostId),
      (agent) => {
        const mounted = mountedByComposer.get(composer);
        if (!composer.isConnected || !mounted) return;
        void switchComposerAgent(mounted, agent);
      },
      (agent) => openInstallPage(agent, hostId),
      async (accountId) => {
        const mounted = mountedByComposer.get(composer);
        if (!composer.isConnected || !mounted) return;
        await selectCodexAccount(mounted, accountId);
      },
      () => {
        void loadCodexAccounts();
      },
      (modelId) => {
        const mounted = mountedByComposer.get(composer);
        if (!composer.isConnected || !mounted) return;
        void selectExternalModel(mounted, modelId);
      },
      (thinkingOptionId) => {
        const mounted = mountedByComposer.get(composer);
        if (!composer.isConnected || !mounted) return;
        void selectExternalThinking(mounted, thinkingOptionId);
      },
      (permissionModeId) => {
        const mounted = mountedByComposer.get(composer);
        if (!composer.isConnected || !mounted) return;
        void selectPermissionMode(mounted, permissionModeId);
      },
      () => {
        const editor = composer.querySelector<HTMLElement>(EDITOR_SELECTOR);
        if (editor) delegationMention?.openFor(editor);
      },
      presentationsForHostState(hostHarnessAvailabilityState(hostId ?? activeAvailabilityHostId)),
    );
    const mounted: MountedComposer = {
      composer,
      composerId: state.composerId,
      control,
      modelTarget,
      modelView: inherited?.modelView ?? { status: "idle" },
      permissionModeView: inherited?.permissionModeView ?? { status: "idle" },
      ownershipStatus: threadIdFromComposerModelTarget(modelTarget)
        ? inherited
          ? "ready"
          : "loading"
        : "not-required",
      threadConfiguration: inherited?.threadConfiguration,
      usage: inherited?.usage ?? null,
      accountCredits: inherited?.accountCredits ?? null,
      hostId: inherited?.hostId ?? hostId,
      usageRequestGeneration: 0,
      commandRequestGeneration: 0,
      commandStatus: "idle",
      commandError: null,
    };
    mountedByComposer.set(composer, mounted);
    if (isComposerModelWriteAllowed(modelTarget)) {
      const model = controller.modelForAgent(composer, state.agent);
      if (shouldApplyDraftAgentCarrier(state.agent)) {
        applyAdapterAgent?.(
          state.agent,
          model,
          state.agent !== "codex"
            ? controller.thinkingOptionForAgent(composer, state.agent)
            : undefined,
          state.agent !== "codex"
            ? controller.permissionModeForAgent(composer, state.agent)
            : undefined,
          composer,
        );
      }
    }
    renderMounted(mounted);
    sidebarAgentIcons.refresh();
    if (threadIdFromComposerModelTarget(modelTarget) && !inherited) {
      void loadThreadOwnership(mounted);
    } else if (
      threadIdFromComposerModelTarget(modelTarget) &&
      inherited &&
      shouldRetryExternalThreadUsage(state.agent, mounted.usage, mounted.accountCredits)
    ) {
      scheduleThreadUsageRefresh(mounted);
    } else if (
      state.agent !== "codex" &&
      !isExternalConfigurationStable(mounted.modelView, mounted.permissionModeView)
    ) {
      void loadExternalCatalog(mounted);
    }
    if (!threadIdFromComposerModelTarget(modelTarget)) void refreshDraftCodexUsage(mounted);
    void refreshCommands(mounted);
  };

  const scan = (): void => {
    scanScheduled = false;
    const refreshTargets = refreshTargetsOnNextScan;
    refreshTargetsOnNextScan = false;
    if (disposed) return;
    settingsLifecycle.refresh();
    for (const [target, replacement] of pendingReplacements) {
      const sourceState = controller.get(replacement.source.composer);
      const replacementTarget = findComposerModelTarget(target);
      const replacementHostId = activeModelHostId(target);
      if (
        !replacementHostId ||
        replacementHostId !== replacement.source.hostId ||
        !shouldTransferComposerState(
          replacement.sourceModelTarget,
          replacementTarget,
          sourceState.phase,
          controller.isSubmissionPending(replacement.source.composer),
        ) ||
        !controller.transfer(
          replacement.source.composer,
          target,
          controllerTarget(replacementTarget, replacementHostId),
        )
      ) {
        pendingReplacements.delete(target);
      }
    }
    for (const [composer, mounted] of mountedByComposer) {
      // Native footer replacement can detach our root with the old send
      // button. Move the existing control to the live footer before deciding
      // it needs disposal, preserving an open menu and its listeners.
      if (
        composer.isConnected &&
        composer.matches(CODEX_COMPOSER_SELECTOR) &&
        !mounted.control.root.isConnected
      ) {
        const state = controller.get(composer);
        const hideCodexControls = controller.isSwitching(composer) || state.agent !== "codex";
        reconcileComposerNativeControls(mounted.control, hideCodexControls, hideCodexControls);
      }
      if (
        !composer.isConnected ||
        !composer.matches(CODEX_COMPOSER_SELECTOR) ||
        !mounted.control.root.isConnected
      ) {
        mounted.usageRequestGeneration += 1;
        usageRefreshAttempts.delete(composer);
        const timer = usageRefreshTimers.get(composer);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          usageRefreshTimers.delete(composer);
        }
        disposeComposerAgentControl(mounted.control);
        mountedByComposer.delete(composer);
        continue;
      }
      const state = controller.get(composer);
      const hideCodexControls = controller.isSwitching(composer) || state.agent !== "codex";
      reconcileComposerNativeControls(mounted.control, hideCodexControls, hideCodexControls);
      if (refreshTargets) refreshMountedConversationTarget(mounted);
    }
    for (const editor of document.querySelectorAll(EDITOR_SELECTOR)) {
      const composer = composerForEditor(editor);
      if (composer) mount(composer);
    }
    reloadMountedOwnershipForHost();
    refreshUsageSubscriptions();
    const localState = hostHarnessAvailabilityState("local");
    const localAvailability = localState.availability;
    if (agentsForHostState(localState).some((agent) => localAvailability[agent] === "checking")) {
      void refreshHarnessAvailabilityForHost("local");
    }
    reconcileHarnessAvailabilityHost();
    for (const hostId of mountedHostIds()) {
      const state = hostHarnessAvailabilityState(hostId);
      if (agentsForHostState(state).some((agent) => state.availability[agent] === "checking")) {
        void refreshHarnessAvailabilityForHost(hostId);
      }
    }
    pendingReplacements.clear();
  };

  const scheduleScan = (refreshTargets = false): void => {
    refreshTargetsOnNextScan ||= refreshTargets;
    if (scanScheduled || disposed) return;
    scanScheduled = true;
    queueMicrotask(scan);
  };

  const composerRootsWithin = (node: Node): Element[] => {
    if (node.nodeType !== Node.ELEMENT_NODE) return [];
    const element = node as Element;
    const roots = element.matches(CODEX_COMPOSER_SELECTOR) ? [element] : [];
    roots.push(...element.querySelectorAll(CODEX_COMPOSER_SELECTOR));
    return roots;
  };

  const transferReplacedComposers = (mutations: MutationRecord[]): void => {
    const replacements = new Map<Node, { removed: Set<Element>; added: Set<Element> }>();
    for (const mutation of mutations) {
      if (mutation.type !== "childList") continue;
      let replacement = replacements.get(mutation.target);
      if (!replacement) {
        replacement = { removed: new Set(), added: new Set() };
        replacements.set(mutation.target, replacement);
      }
      for (const removedNode of mutation.removedNodes) {
        for (const composer of mountedByComposer.keys()) {
          if (
            removedNode === composer ||
            (removedNode.nodeType === Node.ELEMENT_NODE &&
              (removedNode as Element).contains(composer))
          ) {
            replacement.removed.add(composer);
          }
        }
      }
      for (const addedNode of mutation.addedNodes) {
        for (const composer of composerRootsWithin(addedNode)) replacement.added.add(composer);
      }
    }
    for (const replacement of replacements.values()) {
      if (replacement.removed.size !== 1 || replacement.added.size !== 1) continue;
      const source = replacement.removed.values().next().value as Element;
      const target = replacement.added.values().next().value as Element;
      const mounted = mountedByComposer.get(source);
      if (source !== target && mounted) {
        pendingReplacements.set(target, {
          source: mounted,
          sourceModelTarget: mounted.modelTarget,
        });
      }
    }
  };

  const applyComposerAgent = (composer: Element): boolean => {
    const state = controller.get(composer);
    const mounted = mountedByComposer.get(composer);
    if (mounted?.modelTarget?.[0] === "conversation") {
      return state.phase === "locked" && mounted.ownershipStatus === "ready";
    }
    if (!mounted || !isComposerModelWriteAllowed(mounted.modelTarget)) return false;
    const model = controller.modelForAgent(composer, state.agent);
    if (!shouldApplyDraftAgentCarrier(state.agent)) return false;
    return applyComposerModelWrite(
      mounted.modelTarget,
      () =>
        applyAdapterAgent?.(
          state.agent,
          model,
          state.agent !== "codex"
            ? controller.thinkingOptionForAgent(composer, state.agent)
            : undefined,
          state.agent !== "codex"
            ? controller.permissionModeForAgent(composer, state.agent)
            : undefined,
          composer,
        ) ?? state.agent === "codex",
    );
  };
  const blockEvent = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const executableDraftText = (editor: HTMLElement): string => {
    if (editor instanceof HTMLTextAreaElement) return editor.value;
    let text = "";
    const append = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent ?? "";
        return;
      }
      if (!(node instanceof Element)) return;
      if (node.matches("code, pre")) {
        text += "\n";
        return;
      }
      if (node.tagName === "BR") {
        text += "\n";
        return;
      }
      if (node !== editor && node.matches("div, p, li, blockquote") && text && !text.endsWith("\n"))
        text += "\n";
      for (const child of node.childNodes) append(child);
    };
    append(editor);
    return text;
  };
  const commandChipError = (composer: Element, agent: RendererAgent): string | null => {
    const editor = composer.querySelector<HTMLElement>(EDITOR_SELECTOR);
    if (!editor || typeof editor.querySelectorAll !== "function") return null;
    try {
      const draftText = executableDraftText(editor);
      const native = [...editor.querySelectorAll<HTMLElement>("[agent-mention-path]")]
        .filter((element) => !element.closest("code, pre"))
        .map((element) => element.getAttribute("agent-mention-path") ?? "")
        .filter((path) => path.startsWith(HARNESS_COMMAND_MENTION_PATH_PREFIX));
      const typed = decodeHarnessCommandMention(draftText, agent);
      if (native.length + Number(typed.command !== null) > 1) {
        return "Only one command or skill chip can be sent per Turn";
      }
      for (const path of native) {
        decodeHarnessCommandMention(`[@command](${path})`, agent);
      }
      const hasCommand = native.length > 0 || typed.command !== null;
      const hasDelegation =
        stripDelegationMentions(draftText).mentions.length > 0 ||
        [
          ...editor.querySelectorAll(`[agent-mention-path^="${DELEGATION_MENTION_PATH_PREFIX}"]`),
        ].some((element) => !element.closest("code, pre"));
      if (hasCommand && hasDelegation) {
        return "Command and delegation chips cannot be sent in the same Turn";
      }
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  const showComposerCommandError = (composer: Element, error: string | null): void => {
    const existing = composer.querySelector<HTMLElement>("[data-codexhost-command-chip-error]");
    if (!error) {
      existing?.remove();
      return;
    }
    const notice = existing ?? document.createElement("div");
    notice.setAttribute("data-codexhost-command-chip-error", "");
    notice.setAttribute("role", "alert");
    notice.style.color = "var(--color-error, #d04747)";
    notice.style.font = "12px/18px system-ui, sans-serif";
    notice.textContent = error;
    if (!existing) composer.append(notice);
  };
  const prepareComposer = (composer: Element): boolean | null => {
    const mounted = mountedByComposer.get(composer);
    if (!mounted) return null;
    const current = controller.get(composer);
    const chipError = commandChipError(composer, current.agent);
    showComposerCommandError(composer, chipError);
    if (chipError) return false;
    if (
      composerCodexAccounts(composer)?.switching ||
      controller.isSwitching(composer) ||
      isOwnershipSubmissionBlocked(mounted.ownershipStatus)
    ) {
      return false;
    }
    if (!isExternalConfigurationReady(mounted)) return false;
    if (current.phase === "locked") return true;
    if (!applyComposerAgent(composer)) return false;
    if (current.agent === "codex") {
      // A Host switch may replace its policy while retaining this Host's draft
      // override. Apply it to the matching policy at submission, not another Host.
      const selection = composerCodexAccounts(composer)?.selection;
      const accountId =
        controller.isSubmissionPending(composer) && current.codexAccountId
          ? current.codexAccountId
          : selection?.selectedAccountId;
      const override = accountId === selection?.activeAccountId ? null : (accountId ?? null);
      const policy = window.__codexhostHostRoutingV1
        ? window.__codexhostHostRoutingV1.forComposer(composer)?.policy
        : window.__codexhostDraftPrewarmPolicyV1;
      if (override !== null && (policy?.hostId !== mounted.hostId || !policy.selectAccount)) {
        return false;
      }
      try {
        if (policy?.hostId === mounted.hostId) policy.selectAccount?.(override);
      } catch {
        return false;
      }
    }
    controller.markSubmissionPending(composer);
    renderMounted(mounted);
    return true;
  };
  const composerForTarget = (target: EventTarget | null): Element | null => {
    const element = eventElement(target);
    const editor = element ? editorForElement(element) : null;
    const composer = editor ? composerForEditor(editor) : null;
    return composer && isMountedComposer(composer) ? composer : null;
  };
  const onBeforeInput = (event: InputEvent): void => {
    const composer = composerForTarget(event.target);
    if (!composer) return;
    showComposerCommandError(composer, null);
    controller.clearPendingSubmission(composer);
    const mounted = mountedByComposer.get(composer);
    if (mounted && isOwnershipSubmissionBlocked(mounted.ownershipStatus)) return;
    if (controller.isSwitching(composer) || !applyComposerAgent(composer)) blockEvent(event);
  };
  const onSubmit = (event: Event): void => {
    const element = eventElement(event.target);
    const candidate = element ? composerForElement(element) : null;
    const composer = candidate && isMountedComposer(candidate) ? candidate : null;
    if (!composer) return;
    const prepared = prepareComposer(composer);
    if (prepared === null) return;
    if (!prepared) {
      blockEvent(event);
      return;
    }
    notifySubmission(composer, "submit");
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    const composer = isComposerInputIntent(event) ? composerForTarget(event.target) : null;
    const mounted = composer ? mountedByComposer.get(composer) : undefined;
    if (
      composer &&
      (composerCodexAccounts(composer)?.switching || controller.isSwitching(composer))
    ) {
      blockEvent(event);
      return;
    }
    if (composer && mounted && isOwnershipSubmissionBlocked(mounted.ownershipStatus)) {
      if (isComposerSubmissionKey(event)) blockEvent(event);
      return;
    }
    if (composer && !applyComposerAgent(composer)) {
      blockEvent(event);
      return;
    }
    if (!isComposerSubmissionKey(event) || !composer) return;
    if (!prepareComposer(composer)) {
      blockEvent(event);
      return;
    }
    notifySubmission(composer, "enter");
  };
  const onClick = (event: MouseEvent): void => {
    const element = eventElement(event.target);
    const button = element?.closest<HTMLButtonElement>("button");
    if (!button) return;
    const candidate = composerForElement(button);
    const composer = candidate && isMountedComposer(candidate) ? candidate : null;
    const mounted = composer ? mountedByComposer.get(composer) : undefined;
    if (!composer || !mounted || refreshSendButton(mounted.control) !== button) return;
    if (!prepareComposer(composer)) {
      blockEvent(event);
      return;
    }
    notifySubmission(composer, "click");
  };

  const mutationObserver = new MutationObserver((mutations) => {
    transferReplacedComposers(mutations);
    scheduleScan(mutations.some(mutationMayChangeComposerTarget));
  });
  const onHostRouteChange = (): void => {
    sidebarAgentIcons.refresh();
    reloadMountedOwnershipForHost();
    refreshUsageSubscriptions();
    reconcileHarnessAvailabilityHost();
    void loadCodexAccounts();
    void refreshHarnessAvailability();
    for (const hostId of mountedHostIds()) void refreshHarnessAvailabilityForHost(hostId);
    for (const mounted of mountedByComposer.values()) {
      if (controller.get(mounted.composer).agent !== "codex") void refreshCommands(mounted);
      const state = controller.get(mounted.composer);
      if (
        state.agent !== "codex" &&
        !threadIdFromComposerModelTarget(mounted.modelTarget) &&
        !isExternalConfigurationStable(mounted.modelView, mounted.permissionModeView)
      ) {
        void loadExternalCatalog(mounted);
      }
    }
  };
  const onAdapterStatus = () => {
    publishConnectionStatus();
    if (shouldRefreshCodexAccountsForAdapterState(adapterStatus.state)) {
      void loadCodexAccounts();
      sidebarAgentIcons.refresh();
      void refreshHarnessAvailabilityForHost("local");
      void refreshHarnessAvailability();
      for (const hostId of mountedHostIds()) {
        if (hostId !== "local" && hostId !== activeAvailabilityHostId)
          void refreshHarnessAvailabilityForHost(hostId);
      }
      for (const mounted of mountedByComposer.values()) {
        if (mounted.modelView.status === "waitingForAdapter" && mounted.composer.isConnected) {
          applyComposerAgent(mounted.composer);
          void loadExternalCatalog(mounted);
        }
      }
    }
    for (const mounted of mountedByComposer.values()) renderMounted(mounted);
  };
  mutationObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["hidden", "aria-hidden", "data-codex-composer-root"],
    characterData: true,
    childList: true,
    subtree: true,
  });
  document.addEventListener("beforeinput", onBeforeInput, true);
  document.addEventListener("submit", onSubmit, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("click", onClick, true);
  const onWindowFocus = (): void => {
    reconcileHarnessAvailabilityHost();
    refreshUsageSubscriptions();
    void loadCodexAccounts();
    for (const mounted of mountedByComposer.values()) {
      if (
        mounted.hostId === activeModelHostId(mounted.composer) &&
        mounted.ownershipStatus === "error"
      ) {
        void loadThreadOwnership(mounted);
      }
    }
    const local = hostHarnessAvailabilityState("local");
    if (agentsForHostState(local).some((agent) => local.availability[agent] !== "ready")) {
      void refreshHarnessAvailabilityForHost("local", true);
    }
    const active = activeHarnessAvailabilityState();
    if (agentsForHostState(active).some((agent) => active.availability[agent] !== "ready")) {
      void refreshHarnessAvailability(true);
    }
    for (const hostId of mountedHostIds()) {
      if (hostId === activeAvailabilityHostId) continue;
      const state = hostHarnessAvailabilityState(hostId);
      if (agentsForHostState(state).some((agent) => state.availability[agent] !== "ready")) {
        void refreshHarnessAvailabilityForHost(hostId, true);
      }
    }
  };
  const onDraftWorkspace = (event: Event): void => {
    const detail: unknown = (event as CustomEvent).detail;
    if (typeof detail !== "object" || detail === null) return;
    const { hostId, cwd } = detail as { hostId?: unknown; cwd?: unknown };
    if (typeof hostId !== "string" || (cwd !== null && (typeof cwd !== "string" || !cwd))) return;
    const previous = draftWorkspaces.get(hostId);
    if (cwd === null) draftWorkspaces.delete(hostId);
    else draftWorkspaces.set(hostId, cwd);
    for (const mounted of mountedByComposer.values()) {
      if (
        !threadIdFromComposerModelTarget(mounted.modelTarget) &&
        activeModelHostId(mounted.composer) === hostId &&
        controller.get(mounted.composer).agent !== "codex"
      ) {
        void refreshCommands(mounted, { keepCurrent: previous === cwd });
      }
    }
  };
  window.addEventListener("codexhost:draft-prewarm-policy-changed", onHostRouteChange);
  window.addEventListener("codexhost:draft-workspace", onDraftWorkspace);
  window.addEventListener("codexhost:renderer-adapter-status", onAdapterStatus);
  window.addEventListener("focus", onWindowFocus);
  delegationMention = installRendererDelegationMention(document, {
    onOpen: (editor) => {
      const composer = composerForElement(editor);
      const mounted = composer ? mountedByComposer.get(composer) : undefined;
      if (mounted && controller.get(mounted.composer).agent !== "codex") {
        void refreshCommands(mounted, { keepCurrent: true });
      }
    },
    readTargets: (editor) => {
      const composer = composerForElement(editor);
      const hostId = composer
        ? (activeModelHostId(composer) ?? activeAvailabilityHostId)
        : activeAvailabilityHostId;
      const state = hostHarnessAvailabilityState(hostId);
      const presentations = presentationsForHostState(state);
      return enabledAgentsForHost(hostId)
        .filter((agent) => agent !== "codex")
        .map((agent) => {
          const externalAgent = agent as ExternalRendererAgent;
          const availability = state.availability[externalAgent];
          return {
            agent,
            label: rendererAgentLabel(agent, presentations.get(agent)),
            ...(availability === "ready"
              ? {}
              : {
                  disabledReason:
                    state.errors[externalAgent]?.message ??
                    (availability === "checking" || availability === undefined
                      ? settingsLifecycle.locale === "zh-CN"
                        ? "正在连接…"
                        : "Connecting…"
                      : settingsLifecycle.locale === "zh-CN"
                        ? "当前不可用"
                        : "Unavailable"),
                }),
          };
        });
    },
    isComposerEditor: (editor) => {
      const composer = composerForElement(editor);
      return composer !== null && mountedByComposer.has(composer);
    },
    readLocale: () => settingsLifecycle.locale,
    anchorForEditor: (editor) =>
      editor.closest("[data-composer-body]") ?? composerForElement(editor),
    readCommands: (editor) => {
      const composer = composerForElement(editor);
      const mounted = composer ? mountedByComposer.get(composer) : undefined;
      if (!mounted || controller.get(mounted.composer).agent === "codex") return null;
      const { commands, hasSession, executingCommandId, source } =
        mounted.control.harnessCommands.snapshot();
      if (executingCommandId !== null) return null;
      const messages = rendererHarnessMessages(settingsLifecycle.locale);
      const pendingNotice =
        mounted.commandStatus === "loading"
          ? settingsLifecycle.locale === "zh-CN"
            ? "正在加载工作区命令和技能…"
            : "Loading workspace commands and skills…"
          : mounted.commandStatus === "error"
            ? (mounted.commandError ?? messages.commandsUnavailable)
            : source === "static"
              ? rendererStaticCommandsNotice(settingsLifecycle.locale)
              : null;
      return {
        harnessId: controller.get(mounted.composer).agent,
        commands,
        pendingNotice,
        disabledReason: (command) =>
          mounted.commandStatus === "error"
            ? (mounted.commandError ?? messages.commandsUnavailable)
            : mounted.commandStatus === "loading"
              ? pendingNotice
              : !hasSession && rendererHarnessCommandExecutesDirectly(command)
                ? messages.commandRequiresConversation
                : null,
        select: (command) => selectCommand(mounted, command),
      };
    },
  });

  const connectedComposers = (): MountedComposer[] =>
    [...mountedByComposer.values()].filter(
      (mounted) => mounted.composer.isConnected && mounted.control.root.isConnected,
    );

  const api: RendererBindingProbeApi = {
    status() {
      const selections = connectedComposers().map((mounted) => ({
        composerId: mounted.composerId,
        agent: controller.get(mounted.composer).agent,
        phase: controller.get(mounted.composer).phase,
      }));
      return {
        version: 2,
        mountedComposers: selections.length,
        enabledAgents: [...enabledAgents],
        availability: { ...activeHarnessAvailabilityState().availability },
        selections,
        adapter: { ...adapterStatus },
      };
    },
    lockedSelection() {
      const locked = connectedComposers()
        .map((mounted) => ({ mounted, state: controller.get(mounted.composer) }))
        .filter(({ state }) => state.phase === "locked");
      const entry = locked[0];
      if (locked.length !== 1 || !entry) return null;
      const { mounted, state: selection } = entry;
      const model = controller.modelForAgent(mounted.composer, selection.agent);
      const thinkingOptionId =
        selection.agent !== "codex"
          ? controller.thinkingOptionForAgent(mounted.composer, selection.agent)
          : undefined;
      const permissionModeId =
        selection.agent !== "codex"
          ? controller.permissionModeForAgent(mounted.composer, selection.agent)
          : undefined;
      return {
        composerId: selection.composerId,
        agent: selection.agent,
        phase: "locked",
        ...(model ? { model } : {}),
        ...(thinkingOptionId ? { thinkingOptionId } : {}),
        ...(permissionModeId ? { permissionModeId } : {}),
      };
    },
    setAdapter(status, dispose, applyAgent, nextModelControl) {
      for (const entry of usageSubscriptions.values()) entry.dispose();
      usageSubscriptions.clear();
      adapterDispose?.();
      adapterDispose = dispose ?? null;
      applyAdapterAgent = applyAgent ?? null;
      modelControl = nextModelControl ?? null;
      refreshUsageSubscriptions();
      adapterStatus = status;
      publishConnectionStatus();
      const installedModelControl = modelControl;
      queueMicrotask(() => {
        if (disposed || modelControl !== installedModelControl) return;
        try {
          settingsLifecycle.refresh();
        } catch {
          // Auxiliary settings UI must not affect Agent routing compatibility.
        }
      });
      for (const state of harnessAvailabilityByHost.values()) {
        state.requestGeneration += 1;
        state.request = null;
        if (state.retryTimer !== null) window.clearTimeout(state.retryTimer);
      }
      harnessAvailabilityByHost.clear();
      activeAvailabilityHostId = "local";
      sidebarAgentIcons.refresh();
      void refreshHarnessAvailabilityForHost("local");
      for (const hostId of mountedHostIds()) {
        if (hostId !== "local") void refreshHarnessAvailabilityForHost(hostId);
      }
      refreshUsageSubscriptions();
      reconcileHarnessAvailabilityHost();
      void loadCodexAccounts();
      for (const mounted of connectedComposers()) {
        const state = controller.get(mounted.composer);
        if (!threadIdFromComposerModelTarget(mounted.modelTarget)) {
          mounted.hostId = activeModelHostId(mounted.composer);
        }
        if (
          threadIdFromComposerModelTarget(mounted.modelTarget) &&
          mounted.ownershipStatus !== "ready"
        ) {
          void loadThreadOwnership(mounted);
        } else if (state.agent !== "codex") {
          void loadExternalCatalog(mounted);
        } else if (isComposerModelWriteAllowed(mounted.modelTarget)) {
          applyComposerAgent(mounted.composer);
        }
      }
      for (const mounted of mountedByComposer.values()) {
        renderMounted(mounted);
        void refreshCommands(mounted);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of usageSubscriptions.values()) entry.dispose();
      usageSubscriptions.clear();
      adapterDispose?.();
      adapterDispose = null;
      applyAdapterAgent = null;
      modelControl = null;
      mutationObserver.disconnect();
      disposeReasoningSoftWrap();
      sidebarAgentIcons.dispose();
      settingsLifecycle.dispose();
      document.removeEventListener("beforeinput", onBeforeInput, true);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("codexhost:draft-prewarm-policy-changed", onHostRouteChange);
      window.removeEventListener("codexhost:draft-workspace", onDraftWorkspace);
      window.removeEventListener("codexhost:renderer-adapter-status", onAdapterStatus);
      window.removeEventListener("focus", onWindowFocus);
      delegationMention?.dispose();
      delegationMention = null;
      for (const state of harnessAvailabilityByHost.values()) {
        state.requestGeneration += 1;
        if (state.retryTimer !== null) window.clearTimeout(state.retryTimer);
      }
      harnessAvailabilityByHost.clear();
      for (const timer of usageRefreshTimers.values()) window.clearTimeout(timer);
      usageRefreshTimers.clear();
      for (const mounted of mountedByComposer.values()) {
        mounted.usageRequestGeneration += 1;
        usageRefreshAttempts.delete(mounted.composer);
        disposeComposerAgentControl(mounted.control);
      }
      mountedByComposer.clear();
      pendingReplacements.clear();
      connectionListeners.clear();
      connectionDiagnostics = null;
      delete window.__codexhostRendererBindingProbeV1;
    },
  };
  window.__codexhostRendererBindingProbeV1 = api;
  scan();
  return api;
}
