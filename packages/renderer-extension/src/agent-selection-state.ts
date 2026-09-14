import type {
  HarnessModelRef,
  HarnessPermissionModeId,
  HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

/**
 * Compatibility fallback for Hosts that do not expose the plugin directory.
 * Product identity is supplied by `codexhost/harness/plugins/list` at runtime.
 */
export const LEGACY_RENDERER_AGENTS = [
  "codex",
  "pi",
  "claude-code",
  "deepseek-harness",
  "opencode",
  "grok",
  "omp",
  "antigravity",
  "kiro-cli",
  "codebuddy",
  "cursor-cli",
] as const;
/** @deprecated Use the target Host plugin directory for product identity. */
export const KNOWN_RENDERER_AGENTS = LEGACY_RENDERER_AGENTS;
export const DEFAULT_RENDERER_AGENTS = LEGACY_RENDERER_AGENTS;
/** A Harness ID from the target Host, or the isolated official `codex` route. */
export type RendererAgent = string;
export type ExternalRendererAgent = string;
export type RendererAgentAvailability =
  "checking" | "ready" | "notInstalled" | "unavailable" | "error";
export type ComposerAgentPhase = "draft" | "locked";

export interface ExternalComposerConfiguration {
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
}

type ExternalComposerConfigurationUpdate = {
  model?: HarnessModelRef | undefined;
  thinkingOptionId?: HarnessThinkingOptionId | undefined;
  permissionModeId?: HarnessPermissionModeId | undefined;
};

export interface DraftComposerState {
  agent: RendererAgent;
  phase: ComposerAgentPhase;
  composerId: string;
  codexAccountId?: string;
  externalConfigurationByAgent?: Readonly<
    Record<ExternalRendererAgent, ExternalComposerConfiguration>
  >;
}

type MutableComposerState = DraftComposerState;

interface ConversationState {
  target: readonly unknown[];
  state: MutableComposerState;
}

export interface DraftAgentControllerOptions {
  idFactory?: (sequence: number) => string;
  enabledAgents?: readonly RendererAgent[];
  defaultAgent?: RendererAgent;
}

export interface DraftAgentSwitchOperations {
  applyAgent(agent: RendererAgent): boolean;
  clearPrewarm(): Promise<void>;
}

function defaultIdFactory(sequence: number): string {
  return `codexhost-composer-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function isDefaultTarget(target: readonly unknown[] | null): target is readonly unknown[] {
  return target?.[0] === "default";
}

function isConversationTarget(target: readonly unknown[] | null): target is readonly unknown[] {
  return target?.[0] === "conversation";
}

function sameTarget(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export class DraftAgentController<Composer extends object> {
  readonly #idFactory: (sequence: number) => string;
  readonly #defaultAgent: RendererAgent;
  readonly #enabledAgents: Set<RendererAgent>;
  readonly #conversationStates: ConversationState[] = [];
  readonly #modelRequestGenerations = new WeakMap<MutableComposerState, number>();
  readonly #ownershipRequestGenerations = new WeakMap<MutableComposerState, number>();
  readonly #states = new WeakMap<Composer, MutableComposerState>();
  readonly #switching = new Set<MutableComposerState>();
  readonly #pendingSubmissions = new Set<MutableComposerState>();
  #composerSequence = 0;
  #modelRequestSequence = 0;
  #ownershipRequestSequence = 0;
  #lastSubmittedAgent: RendererAgent;

  constructor(options: DraftAgentControllerOptions = {}) {
    this.#idFactory = options.idFactory ?? defaultIdFactory;
    this.#enabledAgents = new Set(options.enabledAgents ?? DEFAULT_RENDERER_AGENTS);
    if (!this.#enabledAgents.has("codex")) {
      throw new Error("Renderer enabled Agents must include Codex");
    }
    this.#defaultAgent = options.defaultAgent ?? "codex";
    if (!this.#enabledAgents.has(this.#defaultAgent)) {
      throw new Error("Renderer default Agent must be enabled");
    }
    this.#lastSubmittedAgent = this.#defaultAgent;
  }

  get(composer: Composer): Readonly<DraftComposerState> {
    return this.#state(composer);
  }

  setEnabledAgents(agents: readonly RendererAgent[]): void {
    const next = new Set(agents);
    if (!next.has("codex")) throw new Error("Renderer enabled Agents must include Codex");
    this.#enabledAgents.clear();
    for (const agent of next) this.#enabledAgents.add(agent);
    if (!this.#enabledAgents.has(this.#lastSubmittedAgent)) this.#lastSubmittedAgent = "codex";
  }

  mount(
    composer: Composer,
    target: readonly unknown[] | null,
    preferredNewThreadAgent?: RendererAgent,
  ): Readonly<DraftComposerState> {
    const bound = this.#conversationState(target);
    if (bound) {
      this.#states.set(composer, bound);
      return bound;
    }
    const preferredAgent =
      preferredNewThreadAgent && this.#enabledAgents.has(preferredNewThreadAgent)
        ? preferredNewThreadAgent
        : this.#lastSubmittedAgent;
    const state = this.#state(composer, isDefaultTarget(target) ? preferredAgent : "codex");
    if (isConversationTarget(target)) {
      this.#conversationStates.push({ target, state });
    }
    return state;
  }

  isSwitching(composer: Composer): boolean {
    return this.#switching.has(this.#state(composer));
  }

  beginModelRequest(composer: Composer): number {
    const state = this.#state(composer);
    const generation = ++this.#modelRequestSequence;
    this.#modelRequestGenerations.set(state, generation);
    return generation;
  }

  invalidateModelRequests(composer: Composer): void {
    this.beginModelRequest(composer);
  }

  isCurrentModelRequest(composer: Composer, generation: number): boolean {
    return (this.#modelRequestGenerations.get(this.#state(composer)) ?? 0) === generation;
  }

  beginOwnershipRequest(composer: Composer): number {
    const state = this.#state(composer);
    const generation = ++this.#ownershipRequestSequence;
    this.#ownershipRequestGenerations.set(state, generation);
    return generation;
  }

  isCurrentOwnershipRequest(composer: Composer, generation: number): boolean {
    return (this.#ownershipRequestGenerations.get(this.#state(composer)) ?? 0) === generation;
  }

  rebindConversation(
    composer: Composer,
    target: readonly unknown[] | null,
  ): Readonly<DraftComposerState> | null {
    if (!isConversationTarget(target)) return null;
    const previous = this.#state(composer);
    this.#pendingSubmissions.delete(previous);
    this.#modelRequestGenerations.set(previous, ++this.#modelRequestSequence);
    this.#ownershipRequestGenerations.set(previous, ++this.#ownershipRequestSequence);

    let state = this.#conversationState(target);
    if (!state) {
      state = {
        agent: "codex",
        phase: "draft",
        composerId: this.#idFactory(++this.#composerSequence),
      };
      this.#conversationStates.push({ target, state });
    }
    this.#states.set(composer, state);
    this.#modelRequestGenerations.set(state, ++this.#modelRequestSequence);
    this.#ownershipRequestGenerations.set(state, ++this.#ownershipRequestSequence);
    return state;
  }

  restore(
    composer: Composer,
    agent: RendererAgent,
    model?: HarnessModelRef,
    thinkingOptionId?: HarnessThinkingOptionId,
    permissionModeId?: HarnessPermissionModeId,
    codexAccountId?: string,
  ): Readonly<DraftComposerState> | null {
    if (!this.#enabledAgents.has(agent)) return null;
    const state = this.#state(composer);
    this.#pendingSubmissions.delete(state);
    state.agent = agent;
    state.phase = "locked";
    if (agent === "codex" && codexAccountId) state.codexAccountId = codexAccountId;
    else delete state.codexAccountId;
    if (agent !== "codex") {
      this.#setExternalConfiguration(state, agent, {
        model,
        thinkingOptionId,
        permissionModeId,
      });
    }
    return state;
  }

  modelForAgent(composer: Composer, agent: RendererAgent): HarnessModelRef | undefined {
    return this.#state(composer).externalConfigurationByAgent?.[agent]?.model;
  }

  thinkingOptionForAgent(
    composer: Composer,
    agent: ExternalRendererAgent,
  ): HarnessThinkingOptionId | undefined {
    return this.#state(composer).externalConfigurationByAgent?.[agent]?.thinkingOptionId;
  }

  permissionModeForAgent(
    composer: Composer,
    agent: ExternalRendererAgent,
  ): HarnessPermissionModeId | undefined {
    return this.#state(composer).externalConfigurationByAgent?.[agent]?.permissionModeId;
  }

  setExternalPermissionMode(
    composer: Composer,
    agent: ExternalRendererAgent,
    permissionModeId: HarnessPermissionModeId,
  ): Readonly<DraftComposerState> {
    const state = this.#state(composer);
    this.#setExternalConfiguration(state, agent, { permissionModeId });
    return state;
  }

  setExternalModel(
    composer: Composer,
    agent: ExternalRendererAgent,
    model: HarnessModelRef,
  ): Readonly<DraftComposerState> {
    const state = this.#state(composer);
    this.#setExternalConfiguration(state, agent, { model });
    return state;
  }

  setExternalThinkingOption(
    composer: Composer,
    agent: ExternalRendererAgent,
    thinkingOptionId?: HarnessThinkingOptionId,
  ): Readonly<DraftComposerState> {
    const state = this.#state(composer);
    this.#setExternalConfiguration(state, agent, { thinkingOptionId });
    return state;
  }

  lock(composer: Composer): Readonly<DraftComposerState> {
    const state = this.#state(composer);
    this.#pendingSubmissions.delete(state);
    state.phase = "locked";
    return state;
  }

  markSubmissionPending(composer: Composer): Readonly<DraftComposerState> {
    const state = this.#state(composer);
    if (state.phase === "draft") this.#pendingSubmissions.add(state);
    return state;
  }

  isSubmissionPending(composer: Composer): boolean {
    return this.#pendingSubmissions.has(this.#state(composer));
  }

  clearPendingSubmission(composer: Composer): void {
    const state = this.#state(composer);
    this.#pendingSubmissions.delete(state);
    if (state.phase === "draft") delete state.codexAccountId;
  }

  recordSubmission(composer: Composer, codexAccountId?: string): Readonly<DraftComposerState> {
    const state = this.#state(composer);
    if (
      state.agent === "codex" &&
      state.phase === "draft" &&
      !state.codexAccountId &&
      codexAccountId
    ) {
      state.codexAccountId = codexAccountId;
    }
    this.#lastSubmittedAgent = state.agent;
    return state;
  }

  transfer(
    source: Composer,
    replacement: Composer,
    target: readonly unknown[] | null = null,
  ): boolean {
    const state = this.#states.get(source);
    if (!state) return false;
    const bound = this.#conversationState(target);
    if (bound && bound !== state) return false;
    if (source !== replacement) {
      if (this.#states.has(replacement)) return false;
      this.#states.set(replacement, state);
    }
    if (isConversationTarget(target) && !bound) {
      this.#conversationStates.push({ target, state });
    }
    if (isConversationTarget(target) && this.#pendingSubmissions.delete(state)) {
      state.phase = "locked";
    }
    return true;
  }

  async switchAgent(
    composer: Composer,
    nextAgent: RendererAgent,
    operations: DraftAgentSwitchOperations,
  ): Promise<boolean> {
    const state = this.#state(composer);
    if (!this.#enabledAgents.has(nextAgent)) return false;
    if (state.phase !== "draft" || this.#switching.has(state)) return false;
    if (state.agent === nextAgent) return true;

    this.#pendingSubmissions.delete(state);

    this.#switching.add(state);
    try {
      if (!operations.applyAgent(nextAgent)) return false;
      try {
        await operations.clearPrewarm();
      } catch (error) {
        if (!operations.applyAgent(state.agent)) {
          throw new Error("Draft Agent switch could not restore the prior Agent", {
            cause: error,
          });
        }
        return false;
      }
      state.agent = nextAgent;
      return true;
    } finally {
      this.#switching.delete(state);
    }
  }

  #conversationState(target: readonly unknown[] | null): MutableComposerState | null {
    if (!isConversationTarget(target)) return null;
    return (
      this.#conversationStates.find((candidate) => sameTarget(candidate.target, target))?.state ??
      null
    );
  }

  #setExternalConfiguration(
    state: MutableComposerState,
    agent: ExternalRendererAgent,
    update: ExternalComposerConfigurationUpdate,
  ): void {
    const current = state.externalConfigurationByAgent?.[agent] ?? {};
    const next: ExternalComposerConfiguration = { ...current };
    if (update.model !== undefined) next.model = update.model;
    if (update.thinkingOptionId !== undefined) next.thinkingOptionId = update.thinkingOptionId;
    if (update.permissionModeId !== undefined) next.permissionModeId = update.permissionModeId;
    if ("model" in update && update.model === undefined) delete next.model;
    if ("thinkingOptionId" in update && update.thinkingOptionId === undefined) {
      delete next.thinkingOptionId;
    }
    if ("permissionModeId" in update && update.permissionModeId === undefined) {
      delete next.permissionModeId;
    }
    if (Object.keys(next).length === 0) {
      const remaining = Object.fromEntries(
        Object.entries(state.externalConfigurationByAgent ?? {}).filter(
          ([candidate]) => candidate !== agent,
        ),
      ) as Record<ExternalRendererAgent, ExternalComposerConfiguration>;
      if (Object.keys(remaining).length === 0) delete state.externalConfigurationByAgent;
      else state.externalConfigurationByAgent = remaining;
      return;
    }
    state.externalConfigurationByAgent = {
      ...state.externalConfigurationByAgent,
      [agent]: next,
    };
  }

  #state(composer: Composer, initialAgent?: RendererAgent): MutableComposerState {
    const existing = this.#states.get(composer);
    if (existing) return existing;
    const created: MutableComposerState = {
      agent: initialAgent ?? this.#defaultAgent,
      phase: "draft",
      composerId: this.#idFactory(++this.#composerSequence),
    };
    this.#states.set(composer, created);
    return created;
  }
}
