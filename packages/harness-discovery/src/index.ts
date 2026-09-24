export {
  environmentValue,
  executableExtensions,
  isExecutableFile,
  newestFirst,
  pathDelimiter,
  pathDirectories,
  subdirectoryNames,
  targetPath,
} from "./environment.js";
export { commandInvocation, type CommandInvocation } from "./invocation.js";
export { withNodeRuntimeOnPath } from "./node-runtime.js";
export {
  PROCESS_ANCHOR_PATH_ENV,
  processAnchorPath,
  runOwnedProcess,
  spawnOwnedProcess,
  type OwnedProcess,
  type OwnedProcessOptions,
  type OwnedProcessResult,
  type RunOwnedProcessOptions,
} from "./owned-process.js";
// The tracker is the Host-side fallback behind spawnOwnedProcess, not an entry point.
export type { OwnedProcessTree } from "./owned-process-tree.js";
export {
  harnessCandidates,
  resolveHarnessExecutable,
  VERSION_MANAGER_ROOTS,
  type HarnessCandidate,
  type HarnessCandidateSource,
  type HarnessDiscoveryDependencies,
  type HarnessDiscoveryInput,
  type HarnessDiscoverySpec,
  type HarnessResolution,
  type RunnableCandidateContext,
} from "./resolve.js";
export { versionManagerBinaryDirectories, type VersionManagerContext } from "./version-managers.js";
