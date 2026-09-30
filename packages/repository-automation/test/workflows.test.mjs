import { readFile } from "node:fs/promises";
import path from "node:path";
import { format } from "prettier";
import { describe, expect, it } from "vitest";
import { CI_JOBS } from "../src/policy.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (file) => readFile(path.join(root, file), "utf8");

describe("workflow and form contracts", () => {
  it.each([
    ".github/workflows/ci.yml",
    ".github/workflows/repository-maintenance.yml",
    ".github/workflows/release-packages.yml",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/question.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
  ])("parses %s as YAML", async (file) => {
    await expect(format(await read(file), { parser: "yaml" })).resolves.toBeTypeOf("string");
  });

  it("retains human-readable Issue forms with unique field IDs", async () => {
    for (const name of ["bug_report", "feature_request", "question"]) {
      const source = await read(`.github/ISSUE_TEMPLATE/${name}.yml`);
      const ids = [...source.matchAll(/^\s+id: (\S+)$/gmu)].map((match) => match[1]);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("keeps CI job names synchronized with the actual matrix", async () => {
    const workflow = await read(".github/workflows/ci.yml");
    expect(workflow).toContain("name: Check ${{ matrix.os }}");
    for (const name of CI_JOBS.filter((value) => value !== "Check Linux ARM64")) {
      expect(workflow).toContain(`- ${name.slice("Check ".length)}\n`);
    }
    expect(workflow).toContain("name: Check Linux ARM64");
  });

  it("cancels superseded PR runs while keeping main-push runs independent", async () => {
    const workflow = await read(".github/workflows/ci.yml");
    expect(workflow).toContain(
      "group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.run_id }}",
    );
    expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });

  it("runs static checks once and preserves tests, anchor builds, and package smokes on every OS", async () => {
    const workflow = await read(".github/workflows/ci.yml");
    expect(workflow.match(/run: npm run check\n/gu)).toHaveLength(1);
    expect(workflow).toContain("if: matrix.os == 'ubuntu-22.04'\n        run: npm run check");
    for (const suite of ["typescript", "rust"]) {
      expect(workflow).toContain(
        `if: matrix.os != 'ubuntu-22.04'\n        run: npm run test:${suite}`,
      );
      expect(workflow).toMatch(
        new RegExp(`name: Test [^\\n]+ on Linux ARM64\\n        run: npm run test:${suite}`),
      );
    }
    // Independent steps retain a failed native process exit on PowerShell.
    expect(workflow).not.toMatch(/run: \|\n\s+npm run test:typescript\n\s+npm run test:rust/u);
    expect(workflow.match(/uses: Swatinem\/rust-cache@[a-f0-9]{40}/gu)).toHaveLength(2);
    expect(workflow.match(/cache-workspace-crates: false/gu)).toHaveLength(2);
    expect(workflow.match(/cache-on-failure: false/gu)).toHaveLength(2);
    expect(workflow).toContain("--target linux-x64");
    expect(workflow).toContain("--target linux-arm64");
  });

  it("keeps the shared test scripts and Vitest selection behind each CI test lane", async () => {
    const packageJson = JSON.parse(await read("package.json"));
    expect(packageJson.scripts["test:typescript"]).toContain(
      "cargo build --locked --package codexhost-anchor",
    );
    expect(packageJson.scripts["test:typescript"]).toContain(
      "vitest run --config tests/vitest.config.js",
    );
    expect(packageJson.scripts["test:rust"]).toContain(
      "cargo test --workspace --locked --features",
    );
    expect(packageJson.scripts.check).toContain("npm run typecheck");
    expect(packageJson.scripts.check).toContain("npm run check:rust");
    expect(packageJson.scripts.lint).toContain("tools/check-boundaries.mjs");
    expect(packageJson.scripts.typecheck).toContain("tests/tsconfig.json");

    const vitest = await read("tests/vitest.config.js");
    for (const pattern of [
      "packages/**/test/**/*.test.ts",
      "packages/repository-automation/test/**/*.test.mjs",
      "tests/release/**/*.test.mjs",
      "tools/**/*.test.mjs",
    ])
      expect(vitest).toContain(pattern);
    expect(await read("tests/vitest.setup.js")).toContain("CODEXHOST_PROCESS_ANCHOR_PATH");
  });

  it("runs write-capable maintenance only with trusted code and no dependency installation", async () => {
    const workflow = await read(".github/workflows/repository-maintenance.yml");
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toContain("types: [completed]");
    expect(workflow).not.toMatch(/^ {2}(?:issues|issue_comment|status|schedule):/mu);
    expect(workflow).not.toContain("CodeRabbit");
    expect(workflow).not.toContain("  pull_request:");
    expect(workflow).not.toContain("  pull_request_review:");
    expect(workflow).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toMatch(
      /npm (?:ci|install)|OPENAI_API_KEY|gh pr merge|convertPullRequestToDraft/u,
    );
    expect(workflow).not.toMatch(/github\.event\.(?:issue|pull_request)\.(?:body|title)/u);
  });

  it("pins external Actions and release build/publish checkouts to immutable SHAs", async () => {
    for (const file of [
      ".github/workflows/repository-maintenance.yml",
      ".github/workflows/release-packages.yml",
    ]) {
      const workflow = await read(file);
      for (const [, reference] of workflow.matchAll(/uses: (\S+)/gu))
        expect(reference).toMatch(/@[a-f0-9]{40}$/u);
    }
    const workflow = await read(".github/workflows/release-packages.yml");
    expect(workflow).not.toContain("ref: ${{ needs.prepare.outputs.tag }}");
    expect(workflow.match(/ref: \$\{\{ needs\.prepare\.outputs\.commit_sha \}\}/gu)).toHaveLength(
      3,
    );
    expect(
      workflow.match(/ref: \$\{\{ needs\.prepare\.outputs\.automation_sha \}\}/gu),
    ).toHaveLength(2);
    expect(workflow.match(/await verifyRelease\(/gu)).toHaveLength(2);
    expect(workflow).toContain("release-evidence.json");
  });
});
