import { rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  codexAccountActivateParamsSchema,
  codexAccountCreateParamsSchema,
  codexAccountDeleteParamsSchema,
  codexAccountLoginCancelParamsSchema,
  codexAccountLoginStartParamsSchema,
  codexAccountResetCreditConsumeOutcomeSchema,
  codexAccountResetCreditConsumeParamsSchema,
  codexAccountResetCreditConsumeResultSchema,
  codexAccountUsageParamsSchema,
  codexAccountUsageResultSchema,
  jsonValueSchema,
  type AccountCreditsSnapshot,
  type JsonRpcRequest,
  type JsonValue,
} from "@codexhost/shared-contracts";

import type { AccountRepositoryLike, CodexAccount } from "./account/account-repository.js";
import type { ThreadAccountStoreLike } from "./account/thread-account-store.js";
import type { AccountRateLimits } from "./codex-runtime/account-rate-limits.js";
import type { CodexRuntimePool } from "./codex-runtime/codex-runtime-pool.js";
import { requestObject, rpcEnvelope, rpcError } from "./json-rpc-response.js";

/** An official device-code login in progress for a Codex Account. */
export interface CodexLoginSession {
  accountId: string;
  loginId: string;
  verificationUrl?: string;
  userCode?: string;
}

/** What the Codex Account requests read and change; the Host owns all of it. */
export interface CodexAccountRequestContext {
  readonly accounts: AccountRepositoryLike;
  readonly threadAccounts: ThreadAccountStoreLike;
  readonly runtimes: Pick<CodexRuntimePool, "get" | "remove">;
  readonly rateLimits: Pick<AccountRateLimits, "get" | "reset">;
  readonly loginSessions: Map<string, CodexLoginSession>;
  readonly accountDataDirectory: string;
  write(value: JsonValue): Promise<void>;
  loginSessionKey(accountId: string, loginId: string): string;
  uniqueLoginSession(loginId: string): CodexLoginSession | undefined;
  refreshRateLimits(accountId: string): Promise<void>;
  accountCredits(accountId: string): AccountCreditsSnapshot | null;
  refreshAccountMetadata(): Promise<void>;
  resetUsageState(accountId: string): void;
  diagnose(error: unknown): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How a Codex Account is presented to the Desktop. */
function accountView(context: CodexAccountRequestContext, account: CodexAccount, active: boolean) {
  return {
    accountId: account.accountId,
    label: account.label,
    ...(account.email ? { email: account.email } : {}),
    ...(account.planType ? { planType: account.planType } : {}),
    codexHome: account.codexHome,
    active,
    isDefault: context.accounts.isDefaultAccount(account.accountId),
  };
}

/** Answers the `codexhost/account/*` requests. */
export async function handleCodexAccountRequest(
  request: JsonRpcRequest,
  context: CodexAccountRequestContext,
): Promise<void> {
  try {
    if (request.method === "codexhost/account/usage/inspect") {
      const { accountId } = codexAccountUsageParamsSchema.parse(requestObject(request));
      if (!(await context.accounts.get(accountId))) throw new Error("Unknown Codex Account");
      await context.refreshRateLimits(accountId);
      const usage = context.rateLimits.get(accountId);
      const accountCredits = context.accountCredits(accountId);
      const result = codexAccountUsageResultSchema.parse({
        accountId,
        usage,
        ...(accountCredits ? { accountCredits } : {}),
      });
      await context.write(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
      return;
    }

    if (request.method === "codexhost/account/rate-limit-reset/consume") {
      const params = codexAccountResetCreditConsumeParamsSchema.parse(requestObject(request));
      if (!(await context.accounts.get(params.accountId))) throw new Error("Unknown Codex Account");
      const runtime = await context.runtimes.get(params.accountId);
      const response = await runtime.request("account/rateLimitResetCredit/consume", {
        idempotencyKey: params.idempotencyKey ?? randomUUID(),
      });
      if (isRecord(response.error)) {
        await context.write(rpcEnvelope(request, { error: response.error }));
        return;
      }
      const result = isRecord(response.result) ? response.result : null;
      const outcome = codexAccountResetCreditConsumeOutcomeSchema.safeParse(result?.outcome);
      if (!outcome.success) throw new Error("Official reset-credit consume response is invalid");
      context.rateLimits.reset(params.accountId);
      if (outcome.data === "reset") await context.refreshRateLimits(params.accountId);
      const accountCredits = context.accountCredits(params.accountId);
      const consumeResult = codexAccountResetCreditConsumeResultSchema.parse({
        accountId: params.accountId,
        outcome: outcome.data,
        ...(accountCredits ? { accountCredits } : {}),
      });
      await context.write(rpcEnvelope(request, { result: jsonValueSchema.parse(consumeResult) }));
      return;
    }

    if (
      request.method === "codexhost/account/list" ||
      request.method === "codexhost/account/refresh"
    ) {
      if (request.method === "codexhost/account/refresh") {
        await context.refreshAccountMetadata();
      }
      const activeAccountId = await context.accounts.getActiveAccountId();
      const accounts = await context.accounts.list();
      await context.write(
        rpcEnvelope(request, {
          result: {
            accounts: accounts.map((account) =>
              accountView(context, account, account.accountId === activeAccountId),
            ),
          },
        }),
      );
      return;
    }
    if (request.method === "codexhost/account/create") {
      const params = codexAccountCreateParamsSchema.parse(requestObject(request));
      const accountId = randomUUID();
      const account = await context.accounts.upsert({
        accountId,
        codexHome: path.join(context.accountDataDirectory, "codex-homes", accountId),
        label: params.label ?? `Codex Account ${accountId.slice(0, 8)}`,
      });
      const activeAccountId = await context.accounts.getActiveAccountId();
      await context.write(
        rpcEnvelope(request, {
          result: {
            account: accountView(context, account, account.accountId === activeAccountId),
          },
        }),
      );
      return;
    }
    if (request.method === "codexhost/account/activate") {
      const params = codexAccountActivateParamsSchema.parse(requestObject(request));
      await context.accounts.setActiveAccountId(params.accountId);

      const account = await context.accounts.get(params.accountId);
      if (!account) throw new Error(`Unknown Codex Account '${params.accountId}'`);
      await context.write(
        rpcEnvelope(request, {
          result: {
            account: accountView(context, account, true),
          },
        }),
      );
      return;
    }
    if (request.method === "codexhost/account/delete") {
      const params = codexAccountDeleteParamsSchema.parse(requestObject(request));
      if (context.accounts.isDefaultAccount(params.accountId)) {
        throw new Error("The default Codex Account cannot be deleted");
      }
      const account = await context.accounts.get(params.accountId);
      if (!account) throw new Error(`Unknown Codex Account '${params.accountId}'`);
      await context.runtimes.remove(params.accountId);
      await context.accounts.remove(params.accountId);
      await context.threadAccounts.removeByAccount(params.accountId);
      for (const [key, session] of context.loginSessions) {
        if (session.accountId === params.accountId) context.loginSessions.delete(key);
      }
      const managedCodexHome = path.join(
        context.accountDataDirectory,
        "codex-homes",
        params.accountId,
      );
      if (path.resolve(account.codexHome) === path.resolve(managedCodexHome)) {
        try {
          await rm(managedCodexHome, { recursive: true, force: true });
        } catch (error) {
          context.diagnose(error);
        }
      }
      context.resetUsageState(params.accountId);
      await context.write(rpcEnvelope(request, { result: { deletedAccountId: params.accountId } }));
      return;
    }
    if (request.method === "codexhost/account/login/start") {
      const params = codexAccountLoginStartParamsSchema.parse(requestObject(request));
      const runtime = await context.runtimes.get(params.accountId);
      const response = await runtime.request("account/login/start", {
        type: "chatgptDeviceCode",
      });
      if (isRecord(response.error)) {
        await context.write(rpcEnvelope(request, { error: response.error }));
        return;
      }
      const result = isRecord(response.result) ? response.result : null;
      if (
        !result ||
        result.type !== "chatgptDeviceCode" ||
        typeof result.loginId !== "string" ||
        typeof result.verificationUrl !== "string" ||
        typeof result.userCode !== "string"
      ) {
        throw new Error("Official account/login/start response is invalid");
      }
      context.loginSessions.set(context.loginSessionKey(params.accountId, result.loginId), {
        accountId: params.accountId,
        loginId: result.loginId,
        verificationUrl: result.verificationUrl,
        userCode: result.userCode,
      });
      await context.write(
        rpcEnvelope(request, {
          result: {
            accountId: params.accountId,
            loginId: result.loginId,
            verificationUrl: result.verificationUrl,
            userCode: result.userCode,
          },
        }),
      );
      return;
    }
    const params = codexAccountLoginCancelParamsSchema.parse(requestObject(request));
    const session = params.accountId
      ? context.loginSessions.get(context.loginSessionKey(params.accountId, params.loginId))
      : context.uniqueLoginSession(params.loginId);
    if (!session) {
      await context.write(rpcEnvelope(request, { result: { cancelled: false } }));
      return;
    }
    const response = await (
      await context.runtimes.get(session.accountId)
    ).request("account/login/cancel", { loginId: params.loginId });
    if (isRecord(response.error)) {
      await context.write(rpcEnvelope(request, { error: response.error }));
      return;
    }
    context.loginSessions.delete(context.loginSessionKey(session.accountId, session.loginId));
    await context.write(rpcEnvelope(request, { result: { cancelled: true } }));
  } catch (error) {
    await context.write(rpcError(request, -32086, errorMessage(error)));
  }
}
