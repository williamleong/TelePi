import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("package metadata", () => {
  it("declares the Node version required by Pi runtime dependencies", () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const releaseWorkflow = readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
    const ciWorkflow = readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

    expect(packageJson.engines?.node).toBe(">=22.19.0");
    expect(readme).toContain("Node.js 22.19+");
    expect(releaseWorkflow).toContain("node-version: 22.19");
    expect(ciWorkflow).toContain("node-version: 22.19");
    expect(dockerfile).toContain("FROM node:22.19-alpine");
  });

  it("includes the Linux systemd template in GitHub release artifacts", () => {
    const packageScript = readFileSync(path.join(repoRoot, "scripts", "package-release.mjs"), "utf8");

    expect(packageScript).toContain('"systemd/telepi.service"');
  });
});
