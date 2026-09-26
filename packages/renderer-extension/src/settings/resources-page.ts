import type { LoadedSessionsResult } from "@codexhost/shared-contracts";

import type { RendererSettingsPageDefinition } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";
import { createRendererSettingsIcon } from "./icons.js";
import { runBoundedRendererUpdateRequest } from "./update-request.js";

export interface RendererResourcesClient {
  listLoadedSessions(): Promise<LoadedSessionsResult>;
}

class ResourcesUnavailableError extends Error {}

function dateLabel(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    timestamp,
  );
}

export function createResourcesSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererResourcesClient | null,
): RendererSettingsPageDefinition {
  return Object.freeze<RendererSettingsPageDefinition>({
    id: "resources",
    label: messages.pageLabels.resources,
    icon: "resources",
    mount(context) {
      const document = context.content.ownerDocument;
      const header = document.createElement("div");
      header.className = "settings-resources-header";
      const heading = document.createElement("strong");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.resources;
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.className = "settings-command-button settings-command-button--secondary";
      refresh.append(createRendererSettingsIcon("refresh", 16), messages.resourcesRefresh);
      header.append(heading, refresh);

      const description = document.createElement("p");
      description.className = "settings-page-description";
      description.textContent = messages.resourcesDescription;
      const status = document.createElement("p");
      status.className = "settings-resources-status";
      status.setAttribute("role", "status");
      const list = document.createElement("div");
      list.className = "settings-resources-list";
      context.content.append(header, description, status, list);

      const showStatus = (message: string, state: string): void => {
        status.textContent = message;
        status.dataset.state = state;
        list.replaceChildren();
      };
      const showSessions = (result: LoadedSessionsResult): void => {
        if (result.sessions.length === 0) {
          showStatus(messages.resourcesEmpty, "empty");
          return;
        }
        status.textContent = "";
        status.dataset.state = "ready";
        const rows = result.sessions.map((session) => {
          const row = document.createElement("article");
          row.className = "settings-resource-row";
          row.dataset.resourceState = session.resourceState;
          const identity = document.createElement("div");
          identity.className = "settings-resource-row__identity";
          const title = document.createElement("strong");
          title.textContent = session.harnessId;
          const thread = document.createElement("code");
          thread.textContent = session.threadId;
          identity.append(title, thread);
          const facts = document.createElement("div");
          facts.className = "settings-resource-row__facts";
          const state = document.createElement("span");
          state.textContent = messages.resourcesState[session.resourceState];
          const running = document.createElement("span");
          running.textContent = session.running
            ? messages.resourcesRunning
            : messages.resourcesNotRunning;
          const activity = document.createElement("span");
          activity.textContent = `${messages.resourcesLastActivity}: ${dateLabel(session.lastActivityAt, messages.locale)}`;
          facts.append(state, running, activity);
          if (session.lastRelease) {
            const release = document.createElement("span");
            release.className = "settings-resource-row__release";
            release.textContent = `${messages.resourcesLastRelease}: ${messages.resourcesReleaseStatus[session.lastRelease.status]} · ${dateLabel(session.lastRelease.observedAt, messages.locale)}`;
            facts.append(release);
          }
          row.append(identity, facts);
          return row;
        });
        list.replaceChildren(...rows);
      };
      const load = (): void => {
        showStatus(messages.resourcesLoading, "loading");
        void context.runLatest(
          (signal) => {
            const client = getClient();
            if (!client) throw new ResourcesUnavailableError();
            return runBoundedRendererUpdateRequest(() => client.listLoadedSessions(), signal);
          },
          {
            success(result) {
              showSessions(result);
            },
            failure(error) {
              showStatus(
                error instanceof ResourcesUnavailableError
                  ? messages.resourcesUnavailable
                  : messages.resourcesLoadFailed,
                error instanceof ResourcesUnavailableError ? "unavailable" : "error",
              );
            },
          },
        );
      };
      refresh.addEventListener("click", load);
      load();
      return () => refresh.removeEventListener("click", load);
    },
  });
}
