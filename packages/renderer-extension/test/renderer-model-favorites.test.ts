import { describe, expect, it } from "vitest";
import { harnessModelRefSchema } from "@codexhost/shared-contracts";
import {
  readModelFavorites,
  writeModelFavorites,
  type ModelFavoritesStorage,
} from "../src/renderer-model-favorites.js";

describe("Model favorites", () => {
  it("round trips full refs per Harness without provider identity bleed", () => {
    const data = new Map<string, string>();
    const storage: ModelFavoritesStorage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
    };
    const piFavorites = new Map([
      ["pi-model-v1.providerA", harnessModelRefSchema.parse({ id: "pi-model-v1.providerA" })],
      ["pi-model-v1.providerB", harnessModelRefSchema.parse({ id: "pi-model-v1.providerB" })],
    ]);
    writeModelFavorites("pi", piFavorites, storage);
    writeModelFavorites(
      "omp",
      new Map([
        ["pi-model-v1.providerA", harnessModelRefSchema.parse({ id: "pi-model-v1.providerA" })],
      ]),
      storage,
    );

    expect([...readModelFavorites("pi", storage).values()]).toEqual([
      { id: "pi-model-v1.providerA" },
      { id: "pi-model-v1.providerB" },
    ]);
    expect([...readModelFavorites("omp", storage).keys()]).toEqual(["pi-model-v1.providerA"]);
    piFavorites.delete("pi-model-v1.providerA");
    writeModelFavorites("pi", piFavorites, storage);
    expect([...readModelFavorites("pi", storage).keys()]).toEqual(["pi-model-v1.providerB"]);
    expect([...readModelFavorites("omp", storage).keys()]).toEqual(["pi-model-v1.providerA"]);
  });

  it("ignores invalid storage and reads legacy opaque IDs", () => {
    const storage: ModelFavoritesStorage = {
      getItem: () => '["valid",null,2,{"id":"another"},{"id":"bad/id"}]',
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect([...readModelFavorites("pi", storage).keys()]).toEqual(["valid", "another"]);
    expect(() => writeModelFavorites("pi", new Map(), storage)).not.toThrow();
    expect(readModelFavorites("pi", null).size).toBe(0);
    expect(readModelFavorites("pi", { ...storage, getItem: () => "bad json" }).size).toBe(0);
  });
});
