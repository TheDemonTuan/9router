// Load optional runtime dependencies only from provisioned installations.
// Never download or execute package-manager scripts while serving a request.

import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { getWritableDataDir } from "../utils/writableDataDir.js";

// Keep in sync with package.json optionalDependencies.
const LAZY_DEP_VERSIONS = {
  "playwright-core": "^1.62.1",
  "wreq-js": "^3.2.0",
};

function getRuntimeDir() {
  return path.join(getWritableDataDir(), "runtime");
}

function isModuleMissing(error) {
  const code = String(error?.code || "");
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
}


const inflight = new Map();

async function load(pkg) {
  // 1) Resolvable from the app install (dev machine / traced standalone).
  try {
    return await import(/* webpackIgnore: true */ pkg);
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
  }
  // 2) Already present in the runtime dir from a previous install.
  const runtimeRequire = createRequire(path.join(getRuntimeDir(), "package.json"));
  try {
    return await import(pathToFileURL(runtimeRequire.resolve(pkg)).href);
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
  }
  const version = LAZY_DEP_VERSIONS[pkg];
  throw new Error(
    `${pkg} is not installed; this provider requires a provisioned optional runtime dependency. ` +
    `Install ${pkg}@${version} with the application, or in "${getRuntimeDir()}" before starting the server.`
  );
}

export function loadRuntimeDep(pkg) {
  if (!Object.hasOwn(LAZY_DEP_VERSIONS, pkg)) {
    return Promise.reject(new Error(`Unsupported optional runtime dependency: ${pkg}`));
  }
  if (!inflight.has(pkg)) {
    inflight.set(pkg, load(pkg).finally(() => inflight.delete(pkg)));
  }
  return inflight.get(pkg);
}
