import { harnessModelRefSchema, type HarnessModelRef } from "@codexhost/shared-contracts";

const STORAGE_KEY = "codexhost.model-favorites.v1";
const MODEL_REF_ID = /^[A-Za-z0-9._~-]{1,512}$/u;

export interface ModelFavoritesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function rendererStorage(): ModelFavoritesStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readModelFavorites(
  harnessId: string,
  storage: ModelFavoritesStorage | null = rendererStorage(),
): Map<string, HarnessModelRef> {
  try {
    const value: unknown = JSON.parse(storage?.getItem(`${STORAGE_KEY}:${harnessId}`) ?? "[]");
    const favorites = new Map<string, HarnessModelRef>();
    if (Array.isArray(value)) {
      for (const ref of value) {
        const candidate = typeof ref === "string" && MODEL_REF_ID.test(ref) ? { id: ref } : ref;
        const parsed = harnessModelRefSchema.safeParse(candidate);
        if (parsed.success) favorites.set(parsed.data.id, parsed.data);
      }
    }
    return favorites;
  } catch {
    return new Map();
  }
}

export function writeModelFavorites(
  harnessId: string,
  favorites: ReadonlyMap<string, HarnessModelRef>,
  storage: ModelFavoritesStorage | null = rendererStorage(),
): void {
  try {
    storage?.setItem(`${STORAGE_KEY}:${harnessId}`, JSON.stringify([...favorites.values()]));
  } catch {
    // Storage failure must not interrupt Model selection.
  }
}
