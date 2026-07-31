import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const REQUIRED_PI_SDK_RANGE = ">=0.83.0 <0.84.0";
export const REQUIRED_PI_AI_COMPAT_ENTRYPOINT = "@earendil-works/pi-ai/compat";

const PI_AI_PACKAGE_NAME = "@earendil-works/pi-ai";
const PI_AI_COMPAT_EXPORT = "./compat";
const moduleRequire = createRequire(import.meta.url);

type ResolveModule = (specifier: string) => string;

export function assertPiSdkCompatibility(
  resolveModule: ResolveModule = resolvePiAiCompatEntrypoint,
): void {
  try {
    resolveModule(REQUIRED_PI_AI_COMPAT_ENTRYPOINT);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `TelePi requires @earendil-works Pi SDK packages ${REQUIRED_PI_SDK_RANGE}; ` +
        `the resolved SDK does not expose ${REQUIRED_PI_AI_COMPAT_ENTRYPOINT}. ` +
        "Install compatible runtime dependencies or update the Pi SDK packages used by TelePi. " +
        `Resolver error: ${detail}`,
    );
  }
}

function resolvePiAiCompatEntrypoint(specifier: string): string {
  if (specifier !== REQUIRED_PI_AI_COMPAT_ENTRYPOINT) {
    throw new Error(`Unsupported compatibility check specifier: ${specifier}`);
  }

  const packageJsonPath = findPackageJson(PI_AI_PACKAGE_NAME);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    exports?: Record<string, unknown>;
  };

  if (!packageJson.exports?.[PI_AI_COMPAT_EXPORT]) {
    throw new Error(`${PI_AI_PACKAGE_NAME} is missing export ${PI_AI_COMPAT_EXPORT}`);
  }

  return packageJsonPath;
}

function findPackageJson(packageName: string): string {
  const searchPaths = moduleRequire.resolve.paths(packageName) ?? [];
  for (const searchPath of searchPaths) {
    const packageJsonPath = path.join(searchPath, packageName, "package.json");
    if (existsSync(packageJsonPath)) {
      return packageJsonPath;
    }
  }

  throw new Error(`Cannot find ${packageName}/package.json from TelePi runtime`);
}
