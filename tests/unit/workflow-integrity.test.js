import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("GitHub Actions workflow integrity", () => {
  const workflowsDir = path.resolve(__dirname, "../../.github/workflows");
  const workflowFiles = fs.readdirSync(workflowsDir).filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"));

  it("forbids phantom @v7 action versions across all workflows", () => {
    for (const file of workflowFiles) {
      const content = fs.readFileSync(path.join(workflowsDir, file), "utf8");
      expect(content, `File ${file} must not contain @v7 action references`).not.toMatch(/@v7\b/);
    }
  });

  it("enforces valid checkout version @v4 across all workflows", () => {
    for (const file of workflowFiles) {
      const content = fs.readFileSync(path.join(workflowsDir, file), "utf8");
      const checkoutMatches = content.match(/uses:\s*actions\/checkout@[^\s]+/g) || [];
      for (const match of checkoutMatches) {
        expect(match, `File ${file} should use actions/checkout@v4`).toBe("uses: actions/checkout@v4");
      }
    }
  });

  it("verifies release checkout ref and multi-context paths in docker-publish.yml", () => {
    const content = fs.readFileSync(path.join(workflowsDir, "docker-publish.yml"), "utf8");

    // Verify job must check out the target release ref, not default branch HEAD
    expect(content).toMatch(/jobs:\s*[\s\S]*?verify:[\s\S]*?uses:\s*actions\/checkout@v4\s*with:\s*ref:\s*\${{\s*inputs\.release_tag\s*\|\|\s*github\.ref_name\s*}}/);

    // Prepare job must check out the target release tag
    expect(content).toMatch(/prepare:[\s\S]*?uses:\s*actions\/checkout@v4\s*with:\s*ref:\s*\${{\s*inputs\.release_tag\s*\|\|\s*github\.ref_name\s*}}/);

    // Build job must checkout source at validated commit with path: source
    expect(content).toMatch(/uses:\s*actions\/checkout@v4\s*with:\s*ref:\s*\${{\s*needs\.prepare\.outputs\.commit\s*}}\s*path:\s*source/);

    // Build job must checkout workflow Dockerfile with path: workflow
    expect(content).toMatch(/uses:\s*actions\/checkout@v4\s*with:\s*ref:\s*\${{\s*github\.workflow_sha\s*}}\s*path:\s*workflow/);

    // Build job Docker build step must use source context and workflow Dockerfile
    expect(content).toMatch(/context:\s*source\s*file:\s*workflow\/Dockerfile/);
  });

  it("verifies deploy.yml checkout steps use @v4 and build-push uses @v6", () => {
    const content = fs.readFileSync(path.join(workflowsDir, "deploy.yml"), "utf8");

    expect(content).not.toMatch(/actions\/checkout@v[5-9]/);
    expect(content).not.toMatch(/docker\/build-push-action@v[7-9]/);
    expect(content).toMatch(/uses:\s*docker\/build-push-action@v6/);
  });
});
