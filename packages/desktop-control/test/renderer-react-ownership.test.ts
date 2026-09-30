import { describe, expect, it } from "vitest";

import { committedReactAncestors } from "../src/renderer-react-ownership.js";

type Fiber = Record<string, unknown>;

describe("committed React ownership", () => {
  it("uses the published alternate and its actual parent chain", () => {
    const owner: { current?: Fiber } = {};
    const publishedRoot: Fiber = { stateNode: owner };
    const publishedParent: Fiber = { return: publishedRoot, memoizedProps: { hostId: "local" } };
    const publishedEditor: Fiber = { return: publishedParent };
    publishedRoot.child = publishedParent;
    publishedParent.child = publishedEditor;
    owner.current = publishedRoot;

    const staleRoot: Fiber = { stateNode: owner };
    const staleParent: Fiber = {
      return: staleRoot,
      memoizedProps: { hostId: "remote-ssh-discovered:old" },
    };
    const staleEditor: Fiber = { return: staleParent, alternate: publishedEditor };
    publishedEditor.alternate = staleEditor;

    expect(committedReactAncestors(staleEditor)).toEqual([
      publishedEditor,
      publishedParent,
      publishedRoot,
    ]);
  });

  it("uses the published parent of a shared child during React bailout", () => {
    const owner: { current?: Fiber } = {};
    const publishedRoot: Fiber = { stateNode: owner };
    const publishedParent: Fiber = { return: publishedRoot, memoizedProps: { hostId: "local" } };
    const oldRoot: Fiber = { stateNode: owner };
    const oldParent: Fiber = { return: oldRoot };
    const sharedEditor: Fiber = { return: oldParent };
    publishedRoot.child = publishedParent;
    publishedParent.child = sharedEditor;
    owner.current = publishedRoot;

    expect(committedReactAncestors(sharedEditor)).toEqual([
      sharedEditor,
      publishedParent,
      publishedRoot,
    ]);
  });

  it("fails closed for a detached Fiber and for cycles", () => {
    const owner: { current?: Fiber } = {};
    const publishedRoot: Fiber = { stateNode: owner };
    owner.current = publishedRoot;
    const oldRoot: Fiber = { stateNode: owner };
    const detached: Fiber = { return: oldRoot };
    expect(committedReactAncestors(detached)).toEqual([]);

    const returnCycle: Fiber = {};
    returnCycle.return = returnCycle;
    expect(committedReactAncestors(returnCycle)).toEqual([]);

    const currentCycle: Fiber = { return: publishedRoot };
    publishedRoot.child = currentCycle;
    currentCycle.sibling = currentCycle;
    expect(committedReactAncestors(detached)).toEqual([]);
  });

  it("bounds traversal of a deep or corrupt parent chain", () => {
    let node: Fiber = {};
    for (let index = 0; index < 20_001; index += 1) node = { return: node };
    expect(committedReactAncestors(node)).toEqual([]);
  });
});
