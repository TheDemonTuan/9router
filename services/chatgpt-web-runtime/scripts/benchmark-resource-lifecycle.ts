import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChildProcess } from "node:child_process";
import type { BrowserContext, Page, Route, LaunchOptions } from "playwright-core";
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import type { RuntimeService } from "../src/server";
import type * as Zod from "zod";
import type { RuntimeProfiles as RuntimeProfilesInstance } from "../src/profiles";


// Source-only offline runner. Runtime source imports occur only inside the
// isolated worker. Each scenario/sample gets a new network namespace, state store,
// persistent profiles and process tree. No installs, source mutation or deps links.
// Fixture seams match gateway-smoke-fixture.ts and smoke-harness-offline.ts: real
// runtime HTTP/auth/admission/DOM/stdio-MCP, synthetic ChatGPT and private connector.
// This is not a gateway/omp/live-account or production approval compatibility proof.
// Invoke with Bun 1.4.0 and CGW_CHROMIUM_EXECUTABLE=/absolute/browser:
// --source-root ROOT --profiles 3 --concurrency 1,3,5 --rounds 10
// --idle-seconds 330 --samples 3 --output /absolute/proof.json
// Optional CGW_BENCHMARK_CGROUP_ROOT must be a writable delegated cgroup-v2
// subtree; each sample gets its own child group. Artifacts contain scalars only.
type Mode = { browser: "headed" | "headless-text"; adaptive: boolean };
type Scenario = { name: string; concurrency: number; native: boolean; mode: Mode };
type Options = { sourceRoot: string; profiles: number; concurrency: number[]; rounds: number; idleSeconds: number; samples: number; output: string };
type Features = { lazy: boolean; resources: boolean; headless: boolean; adaptive: boolean };
type WorkerInput = { options: Options; scenario: Scenario; sample: number; root: string; browser: string; browserVersion: string; browserSha256: string; features: Features; cgroup: string | null; sourceSha: string; dirty: boolean };
type Measurement = { elapsedMs: number; ttftMs: number | null; completed: boolean; code: string | null; expectedInterrupted?: boolean; taskCompleted?: boolean };
type JsonObject = { [key: string]: JsonValue | undefined };
type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type OutputItem = JsonObject & { type?: string; call_id?: string; role?: string };
type ResponseBody = { status?: string; output?: OutputItem[]; error?: { code?: string } };
type Metrics = { cpuSeconds: number | null; memoryBytes: number | null; memoryPeakBytes: number | null; processPeak?: number;
  processCounts?: { browserProcesses: number | null; xvfbProcesses: number | null; openboxProcesses: number | null } };
type Sample = {
  scenario: Scenario; sample?: number; status: string; code?: string | null; reason?: string; exitCode?: number | null;
  sourceSha?: string; sourceDirty?: boolean; processArch?: string; bunVersion?: string; chromiumVersion?: string | null; chromiumSha256?: string | null;
  features?: Features; metricKind?: string; memoryKind?: string; requests?: Measurement[]; queueWaitMs?: number[] | null;
  sends?: number; newChats?: number; inputToBrowserBytes?: number; browserPeak?: number; tabPeak?: number;
  mcpCalls?: number; mcpResults?: number; nativeToolExecutions?: number; snapshots?: { phase: string; browsers: number; tabs: number; resources: unknown; metrics: Metrics | null }[];
  collectorUnavailable?: boolean; abortObservedAfterPhysicalSend?: boolean; elapsedMs?: number; completedTasks?: number; failures?: number; expectedInterruptions?: number; executingTurnsPeak?: number; waitingToolTurnsPeak?: number;
  completedTasksPerSecond?: number | null; metrics?: Metrics | null; pollDelayCounts?: Record<string, number>; effectiveBrowserMode?: string; lazyColdStateVerified?: boolean;
};
type WorkerResult = Sample & { requests: Measurement[]; sends: number; newChats: number; inputToBrowserBytes: number; browserPeak: number; tabPeak: number;
  mcpCalls: number; mcpResults: number; nativeToolExecutions: number; snapshots: NonNullable<Sample["snapshots"]> };
type AdmissionOptions = { profileId: string; kind: "new" | "continuation"; signal?: AbortSignal };
type Lease = { resume(signal?: AbortSignal): Promise<void>; suspendForExternalTools(): void };
type Budget = { acquire(options: AdmissionOptions): Promise<Lease>; snapshot(): { executingTurns: number; waitingToolTurns: number } };
type DomPollState = { signature: string; externalRevision: number; activeToolCalls: number; acknowledgedToolBatch: boolean; generationActive: boolean;
  pendingApproval?: boolean; pendingCompletionFence?: boolean; pendingSubmission?: boolean; pendingResultPublication?: boolean };
type CapacityLimits = { maxGlobalBrowsers: number; maxGlobalTurns: number; maxGlobalTabs: number };
function schemas(z: typeof Zod.z) {
  const mode = z.object({ browser: z.enum(["headed", "headless-text"]), adaptive: z.boolean() }).strict();
  const scenario = z.object({ name: z.enum(["idle-boot", "concurrent-tasks", "stateless-rounds", "idle-after-completion", "native-tool-wait-child-continuation", "native-compaction", "native-abort"]), concurrency: z.number().int().min(0).max(64), native: z.boolean(), mode }).strict();
  const features = z.object({ lazy: z.boolean(), resources: z.boolean(), headless: z.boolean(), adaptive: z.boolean() }).strict();
  const options = z.object({ sourceRoot: z.string(), profiles: z.number().int().min(1).max(32), concurrency: z.array(z.number().int().min(1).max(64)), rounds: z.number().int().min(1).max(100), idleSeconds: z.number().int().min(0).max(3600), samples: z.number().int().min(1).max(20), output: z.string() }).strict();
  const nullableNumber = z.number().nonnegative().nullable();
  const code = z.string().regex(/^[a-z][a-z0-9_]{0,95}$/).nullable();
  const metrics = z.object({ cpuSeconds: nullableNumber, memoryBytes: nullableNumber, memoryPeakBytes: nullableNumber, processPeak: z.number().int().optional(),
    processCounts: z.object({ browserProcesses: nullableNumber, xvfbProcesses: nullableNumber, openboxProcesses: nullableNumber }).optional() });
  // Whitelist diagnostics fields so future IDs/tokens cannot enter artifacts.
  const tabs = z.object({ active: z.number(), retainedNative: z.number(), retainedGeneric: z.number(), inspection: z.number() });
  const resources = z.object({ limits: z.object({ maxGlobalBrowsers: z.number().int().positive(), maxGlobalTurns: z.number().int().positive(), maxGlobalTabs: z.number().int().positive(),
    maxRetainedTabsPerProfile: z.number().int().positive(), maxQueueSize: z.number().int().nonnegative(), queueTimeoutMs: z.number().positive(), browserIdleTtlMs: z.number().positive(), browserMode: z.enum(["headed", "headless-text"]), adaptiveDomPolling: z.boolean() }), browsers: z.number(),
    tabs, executingTurns: z.number(), waitingToolTurns: z.number(), queueDepth: z.number(),
    profiles: z.array(z.object({ profileId: z.string().regex(/^fixture-\d+$/), browserState: z.string(), browsers: z.number(), executingTurns: z.number(), waitingToolTurns: z.number(), tabs, retainedSlots: z.number(), queueDepth: z.number() })),
    totals: z.object({ admitted: z.number(), rejected: z.number(), queueWaitMs: z.number(), polls: z.number(), domCacheHits: z.number(), domCacheMisses: z.number() }) });
  const measurement = z.object({ elapsedMs: z.number().nonnegative(), ttftMs: nullableNumber, completed: z.boolean(), code, expectedInterrupted: z.boolean().optional(), taskCompleted: z.boolean().optional() });
  const sample = z.object({ scenario, sample: z.number().int().optional(), status: z.enum(["failed", "completed", "skipped"]), code: code.optional(), reason: z.string().optional(), exitCode: z.number().nullable().optional(),
    sourceSha: z.string().regex(/^[a-f0-9]{40,64}$/).optional(), sourceDirty: z.boolean().optional(), processArch: z.string().optional(), bunVersion: z.string().optional(), chromiumVersion: z.string().nullable().optional(), chromiumSha256: z.string().nullable().optional(), features: features.optional(),
    metricKind: z.enum(["process-tree", "cgroup-v2-whole-owned-container"]).optional(), memoryKind: z.string().optional(), requests: z.array(measurement).optional(), queueWaitMs: z.array(z.number().nonnegative()).nullable().optional(),
    sends: z.number().int().nonnegative().optional(), newChats: z.number().int().nonnegative().optional(), inputToBrowserBytes: z.number().int().nonnegative().optional(), browserPeak: z.number().int().nonnegative().optional(), tabPeak: z.number().int().nonnegative().optional(),
    mcpCalls: z.number().int().optional(), mcpResults: z.number().int().optional(), nativeToolExecutions: z.number().int().optional(), snapshots: z.array(z.object({ phase: z.string(), browsers: z.number(), tabs: z.number(), resources: resources.nullable(), metrics: metrics.nullable() })).optional(),
    collectorUnavailable: z.boolean().optional(), abortObservedAfterPhysicalSend: z.boolean().optional(), elapsedMs: z.number().nonnegative().optional(), completedTasks: z.number().int().optional(), failures: z.number().int().optional(), expectedInterruptions: z.number().int().optional(), executingTurnsPeak: z.number().int().optional(), waitingToolTurnsPeak: z.number().int().optional(),
    completedTasksPerSecond: nullableNumber.optional(), metrics: metrics.nullable().optional(), pollDelayCounts: z.record(z.string(), z.number().int()).optional(), effectiveBrowserMode: z.enum(["headed", "headless-text"]).optional(), lazyColdStateVerified: z.boolean().optional() });
  const workerInput = z.object({ options, scenario, sample: z.number().int().nonnegative(), root: z.string(), browser: z.string(), browserVersion: z.string(), browserSha256: z.string(), features, cgroup: z.string().nullable(), sourceSha: z.string(), dirty: z.boolean() }).strict();
  return { workerInput, sample, resources };
}
function assert(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
function sourcePath(root: string, path: string) { return join(root, "services/chatgpt-web-runtime", path); }
function text(path: string): string | null { try { return readFileSync(path, "utf8"); } catch { return null; } }
function quantiles(values: number[]) {
  if (!values.length) return { median: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return { median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, p95: sorted[Math.ceil(sorted.length * .95) - 1] };
}
function parseOptions(): Options {
  const args = process.argv.slice(2), values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    assert(["--source-root", "--profiles", "--concurrency", "--rounds", "--idle-seconds", "--samples", "--output"].includes(args[i]) && args[i + 1] && !values.has(args[i]), "invalid_arguments");
    values.set(args[i], args[i + 1]);
  }
  const integer = (flag: string, fallback: string, min: number, max: number) => {
    const raw = values.get(flag) ?? fallback;
    assert(/^\d+$/.test(raw), "invalid_arguments"); const value = Number(raw);
    assert(Number.isSafeInteger(value) && value >= min && value <= max, "invalid_arguments"); return value;
  };
  const root = values.get("--source-root"), output = values.get("--output");
  assert(root && output && isAbsolute(output), "source_root_and_absolute_output_required");
  const concurrency = (values.get("--concurrency") ?? "1,3,5").split(",").map(value => {
    assert(/^[1-9]\d*$/.test(value) && Number(value) <= 64, "invalid_concurrency"); return Number(value);
  });
  assert(new Set(concurrency).size === concurrency.length, "duplicate_concurrency");
  return { sourceRoot: realpathSync(resolve(root)), output: resolve(output), profiles: integer("--profiles", "3", 1, 32), concurrency,
    rounds: integer("--rounds", "10", 1, 100), idleSeconds: integer("--idle-seconds", "330", 0, 3600), samples: integer("--samples", "3", 1, 20) };
}
function inspectSource(root: string): Features {
  for (const file of ["src/server.ts", "src/config.ts", "src/profiles.ts", "scripts/gateway-smoke-fixture.ts", "scripts/smoke-harness-offline.ts", "tests/fixtures/chatgpt-runtime.html"]) {
    assert(existsSync(sourcePath(root, file)), "selected_source_fixture_missing");
  }
  const deps = sourcePath(root, "node_modules");
  assert(existsSync(deps) && !lstatSync(deps).isSymbolicLink() && realpathSync(deps) === deps, "selected_runtime_own_dependencies_required");
  for (const name of ["zod", "playwright-core", "@modelcontextprotocol/sdk/client/index.js", "@modelcontextprotocol/sdk/client/stdio.js"]) {
    const dependency = realpathSync(Bun.resolveSync(name, sourcePath(root, "package.json")));
    assert(dependency.startsWith(deps + sep), "selected_runtime_dependency_escapes_owned_install");
  }
  const config = text(sourcePath(root, "src/config.ts"))!, profiles = text(sourcePath(root, "src/profiles.ts"))!, server = text(sourcePath(root, "src/server.ts"))!;
  const features = { lazy: profiles.includes("prepareForRequest"), resources: server.includes("/admin/resources"), headless: config.includes("CGW_BROWSER_MODE"), adaptive: config.includes("CGW_ADAPTIVE_DOM_POLLING") };
  assert(!existsSync(sourcePath(root, "src/resource-budget.ts")) || features.resources && features.lazy, "candidate_resource_integration_contract_missing");
  return features;
}

// /proc accounting uses lifetime CPU ticks by (pid,starttime), including processes
// observed before exit. Memory sums PSS, never RSS. Both peaks and short-lived child
// CPU are sampled lower bounds; missing smaps/stat data is null, not invented zero.
class ProcessCollector {
  private cpu = new Map<string, number>();
  private observedProcesses = new Set<string>();
  private completeCpu = true;
  private completePss = true;
  private peakPss = 0;
  private peakProcesses = 0;
  private clockTicks: number;
  constructor(private rootPid: number) {
    const value = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
    this.clockTicks = Number(value.stdout?.trim());
    assert(value.status === 0 && this.clockTicks > 0, "proc_clock_tick_rate_unavailable");
  }
  sample() {
    const rows: { pid: number; parent: number; start: string; ticks: number }[] = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const stat = text(`/proc/${name}/stat`); if (!stat) continue;
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      rows.push({ pid: Number(name), parent: Number(fields[1]), start: fields[19], ticks: Number(fields[11]) + Number(fields[12]) });
    }
    const owned = new Set([this.rootPid]);
    for (const row of rows) if (this.observedProcesses.has(`${row.pid}:${row.start}`)) owned.add(row.pid);
    let changed = true;
    while (changed) { changed = false; for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; } }
    let pss = 0, pssComplete = true, namesAvailable = true, browserProcesses = 0, xvfbProcesses = 0, openboxProcesses = 0;
    for (const row of rows.filter(row => owned.has(row.pid))) {
      this.observedProcesses.add(`${row.pid}:${row.start}`);
      if (!Number.isFinite(row.ticks)) this.completeCpu = false;
      else this.cpu.set(`${row.pid}:${row.start}`, Math.max(this.cpu.get(`${row.pid}:${row.start}`) ?? 0, row.ticks));
      const match = /^Pss:\s+(\d+)\s+kB$/m.exec(text(`/proc/${row.pid}/smaps_rollup`) ?? "");
      if (!match) { pssComplete = false; this.completePss = false; } else pss += Number(match[1]) * 1024;
      const name = text(`/proc/${row.pid}/comm`);
      if (!name) namesAvailable = false;
      else if (/^(chrome|chromium)/i.test(name)) browserProcesses++;
      else if (/^Xvfb\s*$/i.test(name)) xvfbProcesses++;
      else if (/^openbox\s*$/i.test(name)) openboxProcesses++;
    }
    this.peakProcesses = Math.max(this.peakProcesses, owned.size);
    if (pssComplete) this.peakPss = Math.max(this.peakPss, pss);
    return { cpuSeconds: this.completeCpu ? [...this.cpu.values()].reduce((a, b) => a + b, 0) / this.clockTicks : null,
      memoryBytes: pssComplete ? pss : null, memoryPeakBytes: this.completePss ? this.peakPss : null, processPeak: this.peakProcesses,
      processCounts: { browserProcesses: namesAvailable ? browserProcesses : null, xvfbProcesses: namesAvailable ? xvfbProcesses : null, openboxProcesses: namesAvailable ? openboxProcesses : null } };
  }
}
function cgroupMeasurement(path: string | null) {
  if (!path) return null;
  const cpu = /(?:^|\n)usage_usec (\d+)/.exec(text(join(path, "cpu.stat")) ?? "");
  const number = (file: string) => { const raw = text(join(path, file)); return raw && /^\d+\s*$/.test(raw) ? Number(raw) : null; };
  return { cpuSeconds: cpu ? Number(cpu[1]) / 1e6 : null, memoryBytes: number("memory.current"), memoryPeakBytes: number("memory.peak") };
}

async function hostMain() {
  assert(process.platform === "linux", "linux_network_namespace_required");
  assert(Bun.version === "1.4.0", "runtime_bun_1_4_0_required");
  const options = parseOptions(), features = inspectSource(options.sourceRoot);
  const outputRelative = relative(options.sourceRoot, options.output);
  assert(outputRelative === ".." || outputRelative.startsWith(".." + sep) || isAbsolute(outputRelative), "output_must_not_mutate_selected_source");
  // Only the selected dependency schema library loads on the host; runtime
  // source remains exclusively inside the network-isolated worker.
  const { z }: typeof Zod = await import(Bun.resolveSync("zod", sourcePath(options.sourceRoot, "package.json")));
  const boundary = schemas(z);
  const browser = process.env.CGW_CHROMIUM_EXECUTABLE;
  assert(browser && isAbsolute(browser) && existsSync(browser), "absolute_chromium_executable_required");
  const browserIdentity = spawnSync(browser, ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH, LANG: "C.UTF-8" } });
  assert(browserIdentity.status === 0 && /^(?:Google Chrome(?: for Testing)?|Chromium)\s+\d+\.\d+\.\d+\.\d+\s*$/.test(browserIdentity.stdout.trim()),
    `exact_chromium_version_unavailable: status=${browserIdentity.status}; stdout=${browserIdentity.stdout.trim()}; stderr=${browserIdentity.stderr.trim()}`);
  const browserVersion = browserIdentity.stdout.trim();
  const namespace = spawnSync("bwrap", ["--die-with-parent", "--unshare-net", "--unshare-pid", "--ro-bind", "/", "/", "--proc", "/proc", "--dev-bind", "/dev", "/dev", "/bin/true"], { stdio: "inherit" });
  assert(namespace.status === 0, "isolated_namespace_prerequisite_failed");
  const browserSha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(realpathSync(browser)).arrayBuffer()).digest("hex");
  const revision = spawnSync("git", ["-C", options.sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  const status = spawnSync("git", ["-C", options.sourceRoot, "status", "--porcelain"], { encoding: "utf8" });
  assert(revision.status === 0 && status.status === 0, "source_revision_unavailable");
  const modes: Mode[] = [{ browser: "headed", adaptive: false }, { browser: "headless-text", adaptive: false }, { browser: "headed", adaptive: true }];
  const scenarios: Scenario[] = [];
  for (const mode of modes) {
    scenarios.push({ name: "idle-boot", concurrency: 0, native: false, mode },
      ...options.concurrency.map(concurrency => ({ name: "concurrent-tasks", concurrency, native: false, mode })),
      { name: "stateless-rounds", concurrency: 1, native: false, mode }, { name: "idle-after-completion", concurrency: 1, native: false, mode },
      { name: "native-tool-wait-child-continuation", concurrency: 1, native: true, mode },
      { name: "native-compaction", concurrency: 1, native: true, mode }, { name: "native-abort", concurrency: 1, native: true, mode });
  }
  const report = { version: 1, sourceSha: revision.stdout.trim(), sourceDirty: !!status.stdout.trim(), sourceRoot: options.sourceRoot,
    processArch: process.arch, bunVersion: Bun.version, browser: { executable: realpathSync(browser), version: browserVersion, sha256: browserSha256 }, features, options: { ...options, sourceRoot: undefined, output: undefined },
    lane: "runtime-http-synthetic-chatgpt-private-stdio-mcp", liveChatGpt: false, actualOmp: false, network: "bwrap-unshare-net",
    genericStateful: "excluded_by_approved_scope", newChatsDefinition: "physical Submit with no prior user-message bubble in the owned conversation DOM", queueWaitDefinition: "actual acquire/resume resolution latency; absent scheduler is null", samples: [] as Sample[], aggregate: [] as object[], limitations: ["Process-tree CPU/PSS peaks are 100ms sampled lower bounds; inaccessible values are null.", "Private MCP replaces outbound connector tunnel, not tool broker or scheduler.", "Native/Full remains headed even when configured headless-text.", "No runtime dependencies are installed and no selected source is modified.", "Source feature detection is an availability label; execution asserts the advertised contracts."] };
  for (const scenario of scenarios) {
    const unsupported = scenario.mode.browser === "headless-text" && !features.headless ? "selected_source_has_no_headless_text_contract"
      : scenario.mode.adaptive && !features.adaptive ? "selected_source_has_no_adaptive_polling_contract" : null;
    if (unsupported) { report.samples.push({ scenario, status: "skipped", reason: unsupported }); continue; }
    for (let sample = 0; sample < options.samples; sample++) {
      // /var/tmp survives the private /tmp bind; all writable state belongs here.
      const root = mkdtempSync("/var/tmp/cgw-resource-benchmark-");
      for (const directory of ["tmp", "home", "data", "config", "cache"]) mkdirSync(join(root, directory), { mode: 0o700 });
      let child: ChildProcess | undefined, cgroup: string | null = null;
      try {
        const cgroupRoot = process.env.CGW_BENCHMARK_CGROUP_ROOT;
        if (cgroupRoot) {
          assert(isAbsolute(cgroupRoot) && existsSync(join(cgroupRoot, "cgroup.controllers")), "delegated_cgroup_v2_root_required");
          cgroup = join(cgroupRoot, `cgw-benchmark-${randomUUID()}`); mkdirSync(cgroup);
        }
        const input: WorkerInput = { options, scenario, sample, root, browser: realpathSync(browser), browserVersion, browserSha256, features, cgroup, sourceSha: report.sourceSha, dirty: report.sourceDirty };
        const resultPath = join(root, "result.json");
        const sandboxArgs = ["--die-with-parent", "--unshare-net", "--unshare-pid", "--ro-bind", "/", "/", "--bind", root, root,
          "--bind", join(root, "tmp"), "/tmp", "--proc", "/proc", "--dev-bind", "/dev", "/dev", "--chdir", sourcePath(options.sourceRoot, ""),
          process.execPath, import.meta.path, "--worker"];
        child = spawn(cgroup ? process.execPath : "bwrap", cgroup ? [import.meta.path, "--cgroup-launcher", cgroup, JSON.stringify(sandboxArgs)] : sandboxArgs,
          { detached: true, stdio: ["pipe", "ignore", "ignore"], env: {
            PATH: process.env.PATH, LANG: "C.UTF-8", HOME: join(root, "home"), USERPROFILE: join(root, "home"), APPDATA: join(root, "home"),
            DATA_DIR: join(root, "data"), CGW_DATA_DIR: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
            ENABLE_REQUEST_LOGS: "false", NEXT_TELEMETRY_DISABLED: "1", CGW_CHROMIUM_EXECUTABLE: browser } });
        assert(child.pid, "sandbox_worker_launch_failed");
        // Cgroup launcher joins before spawning bwrap: moving only an already
        // running bwrap PID could miss children forked before the host write.
        let inputFailed = false;
        child.stdin!.once("error", () => { inputFailed = true; });
        child.stdin!.end(JSON.stringify(input));
        const timeout = setTimeout(() => { if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } }, Math.max(180_000, (options.idleSeconds + 180) * 1000 + options.rounds * 120_000));
        const { promise: exited, resolve: resolveExit, reject: rejectExit } = Promise.withResolvers<number | null>();
        child.once("error", rejectExit); child.once("exit", resolveExit);
        const exit = await exited;
        clearTimeout(timeout);
        const result = text(resultPath);
        report.samples.push(result ? boundary.sample.parse(JSON.parse(result)) : { scenario, sample, status: "failed", code: inputFailed ? "worker_configuration_transport_failed" : "isolated_worker_failed", exitCode: exit });
      } catch {
        report.samples.push({ scenario, sample, status: "failed", code: "sandbox_or_collector_prerequisite_failed" });
      } finally {
        if (child?.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
        if (cgroup) { const kill = join(cgroup, "cgroup.kill"); if (existsSync(kill)) { try { writeFileSync(kill, "1"); } catch {} } try { rmdirSync(cgroup); } catch {} }
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
  for (const scenario of scenarios) {
    const rows = report.samples.filter(row => JSON.stringify(row.scenario) === JSON.stringify(scenario) && row.status !== "skipped");
    if (!rows.length) continue;
    const requests: Measurement[] = rows.flatMap(row => row.requests ?? []);
    report.aggregate.push({ scenario, samples: rows.length, failedSamples: rows.filter(row => row.status !== "completed").length,
      completedTasks: requests.filter(row => row.completed && row.taskCompleted !== false).length, failures: requests.filter(row => !row.completed && !row.expectedInterrupted).length, expectedInterruptions: requests.filter(row => row.expectedInterrupted).length,
      elapsedMs: quantiles(requests.map(row => row.elapsedMs)), ttftMs: quantiles(requests.flatMap(row => row.ttftMs === null ? [] : [row.ttftMs])),
      queueWaitMs: quantiles(rows.flatMap(row => row.queueWaitMs ?? [])),
      cpuSeconds: quantiles(rows.flatMap(row => row.metrics?.cpuSeconds == null ? [] : [row.metrics.cpuSeconds])),
      memoryPeakBytes: quantiles(rows.flatMap(row => row.metrics?.memoryPeakBytes == null ? [] : [row.metrics.memoryPeakBytes])) });
    const aggregate = report.aggregate.at(-1)!;
    Object.assign(aggregate, { scenarioElapsedMs: quantiles(rows.flatMap(row => row.elapsedMs === undefined ? [] : [row.elapsedMs])),
      completedTasksPerSecond: quantiles(rows.flatMap(row => row.completedTasksPerSecond == null ? [] : [row.completedTasksPerSecond])),
      sends: rows.map(row => row.sends ?? null), newChats: rows.map(row => row.newChats ?? null), browserPeak: rows.map(row => row.browserPeak ?? null), tabPeak: rows.map(row => row.tabPeak ?? null),
      inputToBrowserBytes: rows.map(row => row.inputToBrowserBytes ?? null) });
  }
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  if (report.samples.some(row => row.status === "failed")) process.exitCode = 1;
}

async function workerMain() {
  const raw: unknown = JSON.parse(await Bun.stdin.text());
  assert(raw && typeof raw === "object" && "options" in raw && raw.options && typeof raw.options === "object" && "sourceRoot" in raw.options && typeof raw.options.sourceRoot === "string" && isAbsolute(raw.options.sourceRoot), "invalid_worker_source_root");
  const { z }: typeof Zod = await import(Bun.resolveSync("zod", sourcePath(raw.options.sourceRoot, "package.json")));
  const boundary = schemas(z);
  const input: WorkerInput = boundary.workerInput.parse(raw);
  const { options, scenario, features, root } = input;
  const dataDir = join(root, "data"), model = "chatgpt-web/gpt-5.6-sol";
  const result: WorkerResult = { scenario, sample: input.sample, status: "failed", code: null, sourceSha: input.sourceSha, sourceDirty: input.dirty,
    processArch: process.arch, bunVersion: Bun.version, chromiumVersion: input.browserVersion, chromiumSha256: input.browserSha256, features,
    metricKind: input.cgroup ? "cgroup-v2-whole-owned-container" : "process-tree", memoryKind: input.cgroup ? "cgroup-memory-current-and-peak" : "sum-PSS-sampled",
    requests: [], queueWaitMs: features.resources ? [] : null, sends: 0, newChats: 0, inputToBrowserBytes: 0, browserPeak: 0, tabPeak: 0,
    mcpCalls: 0, mcpResults: 0, nativeToolExecutions: 0, snapshots: [] };
  let runtime: RuntimeService | undefined, collector: ProcessCollector | undefined, timer: NodeJS.Timeout | undefined;
  let scenarioStarted: number | null = null, initialCpu: number | null = null;
  let capacityLimits: CapacityLimits | null = null;
  const clients = new Map<string, McpClient>(), contexts = new Set<BrowserContext>(), pages = new Set<Page>(), instrumentedPages = new WeakSet<object>();
  const measurements: Measurement[] = result.requests;
  const requestsByMarker = new Map<string, { sent: () => void }>();
  const importSelected = (file: string) => import(pathToFileURL(sourcePath(options.sourceRoot, file)).href);
  try {
    assert(Bun.version === "1.4.0", "runtime_bun_1_4_0_required");
    process.env.CGW_BROWSER_MODE = scenario.mode.browser;
    process.env.CGW_ADAPTIVE_DOM_POLLING = String(scenario.mode.adaptive);
    process.env.CGW_MAX_GLOBAL_BROWSERS = "2";
    process.env.CGW_MAX_GLOBAL_TURNS = scenario.native ? "1" : "2";
    process.env.CGW_MAX_GLOBAL_TABS = "10";
    result.effectiveBrowserMode = scenario.native ? "headed" : scenario.mode.browser;
    const workspace = join(root, "workspace"); mkdirSync(workspace, { mode: 0o700 });
    writeFileSync(join(workspace, "synthetic.txt"), "CGW_SYNTHETIC_BENCHMARK_INPUT\n", { mode: 0o600 });
    for (const [name, token] of [["CGW_RUNTIME_TOKEN_FILE", "synthetic-benchmark-data-".repeat(4)], ["CGW_ADMIN_TOKEN_FILE", "synthetic-benchmark-admin-".repeat(4)]]) {
      const path = join(root, name); writeFileSync(path, token, { mode: 0o600 }); process.env[name] = path;
    }
    // loadRuntimeConfig rejects port 0 on both revisions. Only startRuntime's
    // binding port is overridden to 0; all resource settings use its real parser.
    const { loadRuntimeConfig, defaultBrokerEndpoint } = await importSelected("src/config.ts");
    const config = { ...loadRuntimeConfig(), dataDir, host: "127.0.0.1", port: 0, chromiumExecutable: input.browser };
    if (features.resources) capacityLimits = z.object({ maxGlobalBrowsers: z.number().int().positive(), maxGlobalTurns: z.number().int().positive(), maxGlobalTabs: z.number().int().positive() }).parse(config.resourceLimits);
    const { RuntimeState } = await importSelected("src/runtime-state.ts");
    const persisted = new RuntimeState(dataDir);
    const profileIds = Array.from({ length: options.profiles }, (_, index) => `fixture-${index}`);
    for (const id of profileIds) {
      const profile = persisted.createProfile(id);
      if (scenario.native) persisted.patchProfile(id, profile.revision, { ...profile.settings, mode: "full" });
    }
    persisted.close();
    // --source-root selects every dependency at runtime; static value imports
    // would silently execute the runner worktree's modules instead of that root.
    const moduleBase = sourcePath(options.sourceRoot, "package.json");
    const { chromium } = await import(Bun.resolveSync("playwright-core", moduleBase));
    const { Client } = await import(Bun.resolveSync("@modelcontextprotocol/sdk/client/index.js", moduleBase));
    const { StdioClientTransport } = await import(Bun.resolveSync("@modelcontextprotocol/sdk/client/stdio.js", moduleBase));
    const jsonSchema: Zod.ZodType<JsonValue> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonSchema), z.record(z.string(), jsonSchema)]));
    const outputSchema = z.object({ type: z.string().optional(), call_id: z.string().optional(), role: z.string().optional() }).catchall(jsonSchema);
    const responseSchema = z.object({ status: z.string().optional(), output: z.array(outputSchema).optional(), error: z.object({ code: z.string().optional() }).optional() });
    const eventSchema = z.object({ type: z.string(), response: responseSchema.optional(), error: z.object({ code: z.string().optional() }).optional() });
    const catalogSchema = z.object({ models: z.array(z.object({ id: z.string(), supported_reasoning_levels: z.array(z.string()) })) });
    const mcpCallSchema = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() });
    const coldProfilesSchema = z.object({ profiles: z.array(z.object({ profileId: z.string(), state: z.string(), browser_state: z.string().optional(), catalog_verified: z.boolean().optional(), models: z.array(z.unknown()) })) });
    const { RuntimeProfiles } = await importSelected("src/profiles.ts");
    const { sha256 } = await importSelected("src/authority.ts");
    const { chatGptTurnSessions } = await importSelected("src/adapters/chatgpt-web/turn-execution.ts");
    if (features.adaptive) {
      const { DomPollCadence } = await importSelected("src/adapters/chatgpt-web/turn-progress.ts");
      assert(DomPollCadence?.prototype?.observe, "advertised_adaptive_cadence_contract_missing");
      result.pollDelayCounts = {};
      const observe = DomPollCadence.prototype.observe;
      DomPollCadence.prototype.observe = function (state: DomPollState) {
        const value: number = observe.call(this, state);
        if (value > 250) assert(state.activeToolCalls > 0 && state.acknowledgedToolBatch && !state.generationActive && !state.pendingApproval && !state.pendingCompletionFence && !state.pendingSubmission && !state.pendingResultPublication, "adaptive_backoff_outside_tool_wait");
        assert([250, 500, 1000].includes(value), "unexpected_dom_poll_delay");
        result.pollDelayCounts![String(value)] = (result.pollDelayCounts![String(value)] ?? 0) + 1;
        if (!scenario.mode.adaptive) assert(value === 250, "fixed_dom_poll_cadence_changed");
        return value;
      };
    }
    const html = readFileSync(sourcePath(options.sourceRoot, "tests/fixtures/chatgpt-runtime.html"), "utf8")
      .replace("if(typeof window.syntheticMcpCall!=='function')return;", "if(typeof window.syntheticMcpCall!=='function'||!/turn_[A-Za-z0-9_-]{32}/.test(composer.innerText))return;");
    assert(html.includes("syntheticMcpCall") && html.includes("fixture__read") && html.includes("data-testid=\"send-button\""), "selected_dom_fixture_contract_missing");
    const launch = chromium.launchPersistentContext.bind(chromium);
    chromium.launchPersistentContext = async (directory: string, launchOptions: LaunchOptions) => {
      assert(launchOptions.chromiumSandbox === true, "chromium_sandbox_must_remain_enabled");
      if (features.headless) assert(launchOptions.headless === (!scenario.native && scenario.mode.browser === "headless-text"), "effective_profile_browser_mode_mismatch");
      const profileId = profileIds.find(id => directory === join(dataDir, "profiles", id, "browser"));
      assert(profileId, "unowned_browser_launch");
      const context = await launch(directory, launchOptions);
      contexts.add(context); result.browserPeak = Math.max(result.browserPeak, contexts.size);
      context.on("close", () => { contexts.delete(context); });
      result.chromiumVersion = context.browser()?.version() ?? result.chromiumVersion;
      const observePage = (page: Page) => {
        if (instrumentedPages.has(page)) return; instrumentedPages.add(page); pages.add(page);
        result.tabPeak = Math.max(result.tabPeak, pages.size); page.once("close", () => pages.delete(page));
      };
      context.pages().forEach(observePage); context.on("page", observePage);
      if (scenario.native && !clients.has(profileId)) {
        const client = new Client({ name: "resource-lifecycle-offline-connector", version: "1" });
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [sourcePath(options.sourceRoot, "src/adapters/chatgpt-web/mcp-main.ts"),
          "--broker-socket", defaultBrokerEndpoint(join(dataDir, "profiles", profileId)), "--contract", "native"], stderr: "pipe",
          env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")) }));
        const inventory = await client.listTools();
        assert(["codex_tool_call", "codex_apply_patch"].every(name => inventory.tools.some((tool: { name: string }) => tool.name === name)), "actual_mcp_inventory_missing");
        clients.set(profileId, client);
      }
      await context.exposeBinding("syntheticMcpCall", async (_source: unknown, call: unknown) => {
        assert(clients.has(profileId), "private_connector_missing"); result.mcpCalls++;
        const response = await clients.get(profileId)!.callTool(mcpCallSchema.parse(call)); result.mcpResults++;
        assert(!response.isError, "actual_mcp_call_failed"); return response;
      });
      await context.exposeBinding("benchmarkObserveSend", (_source: unknown, evidence: { bytes: number; marker: string | null; newChat: boolean }) => {
        result.sends++; result.inputToBrowserBytes += evidence.bytes; if (evidence.newChat) result.newChats++;
        if (evidence.marker) requestsByMarker.get(evidence.marker)?.sent();
      });
      await context.addInitScript(() => {
        document.addEventListener("submit", event => {
          const prompt = document.querySelector<HTMLElement>("#prompt-textarea")?.innerText ?? "";
          if (!prompt.trim()) return;
          void Reflect.get(window, "benchmarkObserveSend")({ bytes: new TextEncoder().encode(prompt).length, marker: /bench:[a-f0-9-]+/.exec(prompt)?.[0] ?? null,
            newChat: !document.querySelector("[data-user-message-bubble]") });
          // Compaction fixture takes the real reserved MCP control route. It does
          // not manufacture a checkpoint response or bypass the broker receipt.
          if (!prompt.includes("<codex_compaction_control>")) return;
          event.preventDefault(); event.stopImmediatePropagation();
          const token = /turn_token\s+(control_[a-f0-9]{32})/.exec(prompt)?.[1];
          const handoff = /handoff_id\s+(\S+)/.exec(prompt)?.[1];
          const wrapper = document.createElement("div"); wrapper.setAttribute("data-turn-key", "benchmark-compaction");
          const user = document.createElement("div"); user.setAttribute("data-user-message-bubble", "");
          const source = document.createElement("div"); source.setAttribute("data-search-result-target", ""); source.style.whiteSpace = "pre-wrap"; source.textContent = prompt;
          user.append(source); wrapper.append(user);
          const answer = document.createElement("div"); answer.setAttribute("data-content-search-unit-key", "benchmark-compaction:assistant");
          answer.innerHTML = '<div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message"><p>Creating synthetic checkpoint.</p></div>';
          wrapper.append(answer); document.querySelector("#turns")!.append(wrapper);
          document.querySelector<HTMLElement>("#prompt-textarea")!.innerText = "";
          const stop = document.createElement("button"); stop.type = "button"; stop.setAttribute("data-testid", "stop-button"); stop.textContent = "Stop";
          document.querySelector("form")!.append(stop);
          void Reflect.get(window, "syntheticMcpCall")({ name: "codex_tool_call", arguments: { turn_token: token,
            wire_name: "codex.control.compaction_handoff", arguments: { handoff_id: handoff, summary: "Synthetic task checkpoint; no local actions executed." } } }).then(() => {
              stop.remove(); const controls = document.createElement("div"); controls.className = "turn-action-controls";
              controls.innerHTML = '<button type="button" data-testid="copy-turn-action-button">Copy</button>'; wrapper.append(controls);
            }, () => { stop.remove(); });
        }, true);
      });
      await context.route("**/*", (route: Route) => {
        const url = new URL(route.request().url());
        if (url.origin !== "https://chatgpt.com") return route.abort();
        return url.pathname === "/api/auth/session" ? route.fulfill({ json: { expires: new Date(Date.now() + 3600000).toISOString(), user: { id: `offline-${profileId}` } } })
          : route.fulfill({ body: html, contentType: "text/html" });
      });
      return context;
    };
    // Install before initialize. A Full fixture proves real stdio inventory and
    // uses real DOM probes but has no outbound connector tunnel. These overrides
    // are local to this disposable process, never changes to selected source.
    if (scenario.native) {
      RuntimeProfiles.prototype.fullReady = function (id: string) { return clients.has(id); };
      RuntimeProfiles.prototype.refreshReadiness = async function (id: string) { assert(clients.has(id) || features.lazy, "private_connector_not_ready"); };
      RuntimeProfiles.prototype.harnessSmoke = async function (this: RuntimeProfilesInstance, id: string, initializing = false) {
        await this.probe(id, true, initializing); assert(clients.has(id), "private_connector_not_ready");
      };
    }
    if (features.resources) {
      const { RuntimeResourceBudget } = await importSelected("src/resource-budget.ts");
      result.executingTurnsPeak = 0; result.waitingToolTurnsPeak = 0;
      const recordBudget = (budget: Budget) => {
        const state = budget.snapshot();
        result.executingTurnsPeak = Math.max(result.executingTurnsPeak ?? 0, state.executingTurns);
        result.waitingToolTurnsPeak = Math.max(result.waitingToolTurnsPeak ?? 0, state.waitingToolTurns);
      };
      assert(RuntimeResourceBudget?.prototype?.acquire, "advertised_resource_budget_contract_missing");
      const acquire = RuntimeResourceBudget.prototype.acquire;
      RuntimeResourceBudget.prototype.acquire = async function (this: Budget, options: AdmissionOptions) {
        const start = performance.now(); const lease: Lease = await acquire.call(this, options); result.queueWaitMs!.push(performance.now() - start); recordBudget(this);
        const suspend = lease.suspendForExternalTools.bind(lease);
        lease.suspendForExternalTools = () => { suspend(); recordBudget(this); };
        const resume = lease.resume.bind(lease); lease.resume = async (signal?: AbortSignal) => {
          const resumed = performance.now(); await resume(signal); result.queueWaitMs!.push(performance.now() - resumed); recordBudget(this);
        };
        return lease;
      };
    }
    collector = new ProcessCollector(process.pid);
    const started = performance.now(); scenarioStarted = started; initialCpu = collector.sample().cpuSeconds;
    timer = setInterval(() => { try { collector!.sample(); } catch { result.collectorUnavailable = true; } }, 100);
    const { startRuntime } = await importSelected("src/server.ts");
    const ownedRuntime: RuntimeService = startRuntime(config); runtime = ownedRuntime; await ownedRuntime.initialized;
    const base = `http://127.0.0.1:${ownedRuntime.server.port}`;
    const headers = (id?: string, admin = false) => ({ authorization: `Bearer ${(admin ? config.adminToken : config.runtimeToken).toString()}`,
      "content-type": "application/json", ...(id ? { "x-cgw-profile-id": id } : {}) });
    const post = (path: string, body: unknown, id: string, signal?: AbortSignal) => fetch(base + path, { method: "POST",
      headers: headers(id), body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000), redirect: "error" });
    const snapshot = async (phase: string) => {
      let resources: unknown = null;
      if (features.resources) {
        const response = await fetch(base + "/admin/resources", { headers: headers(undefined, true) }); assert(response.ok, "advertised_resources_endpoint_failed");
        const measured = boundary.resources.parse(await response.json()); resources = measured; capacityLimits = measured.limits;
        result.executingTurnsPeak = Math.max(result.executingTurnsPeak ?? 0, measured.executingTurns);
        result.waitingToolTurnsPeak = Math.max(result.waitingToolTurnsPeak ?? 0, measured.waitingToolTurns);
      }
      const processMetrics = collector!.sample(); result.snapshots.push({ phase, browsers: contexts.size, tabs: pages.size, resources,
        metrics: input.cgroup ? cgroupMeasurement(input.cgroup) : processMetrics });
    };
    await snapshot("initialized");
    const coldSends = result.sends, coldBrowsers = contexts.size;
    for (let round = 0; round < 10; round++) {
      for (const path of ["/healthz", "/readyz", "/admin/profiles", "/v1/web-models"]) {
        const response = await fetch(base + path, { headers: headers(profileIds[round % profileIds.length], path.startsWith("/admin")), redirect: "error" });
        assert(response.status === 200 || ["/readyz", "/v1/web-models"].includes(path) && response.status === 503, "cold_get_contract_failed");
        if (features.lazy && path === "/admin/profiles") {
          const adminProfiles = coldProfilesSchema.parse(await response.json());
          assert(adminProfiles.profiles.length === options.profiles && adminProfiles.profiles.every(profile => profile.state === "session_unverified" && profile.browser_state === "sleeping" && profile.catalog_verified === false && profile.models.length === 0), "lazy_cold_profile_state_invented");
          result.lazyColdStateVerified = true;
        } else if (features.lazy && path === "/v1/web-models") {
          const coldCatalog = responseSchema.parse(await response.json());
          assert(response.status === 503 && coldCatalog.error?.code === "profile_not_prepared", "lazy_cold_catalog_advertised_models");
        } else await response.arrayBuffer();
      }
    }
    assert(result.sends === coldSends, "cold_gets_sent_inference");
    if (features.lazy) assert(coldBrowsers === 0 && contexts.size === 0, "lazy_cold_gets_launched_browser");
    await snapshot("cold-gets");
    const prepare = async (id: string) => {
      if (features.lazy) {
        const profile = ownedRuntime.state.profile(id);
        const response = await post("/v1/profiles/prepare", { profileId: id, profileEpoch: profile.epoch }, id);
        if (!response.ok) { const body = responseSchema.parse(await response.json()); throw new Error(body.error?.code === "runtime_capacity_exceeded" ? "runtime_capacity_exceeded" : "advertised_prepare_contract_failed"); }
        await response.arrayBuffer();
      } else await ownedRuntime.profiles.probe(id);
      const response = await fetch(base + "/v1/web-models", { headers: headers(id), redirect: "error" });
      assert(response.ok, "prepared_catalog_failed"); const catalog = catalogSchema.parse(await response.json());
      assert(catalog.models.some(row => row.id === model && row.supported_reasoning_levels.includes("high")), "fixture_route_unavailable");
      return ownedRuntime.state.profile(id).epoch;
    };
    const readResponse = async (response: Response, start: number): Promise<{ response: ResponseBody; ttftMs: number | null }> => {
      if (!response.ok) {
        const body = responseSchema.parse(await response.json()); return { response: { status: "failed", error: { code: body.error?.code ?? "http_failure" } }, ttftMs: null };
      }
      if (!response.headers.get("content-type")?.includes("text/event-stream")) return { response: responseSchema.parse(await response.json()), ttftMs: null };
      const reader = response.body!.getReader(), decoder = new TextDecoder(); let pending = "", terminal: ResponseBody | undefined, ttft: number | null = null;
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline).trimEnd(); pending = pending.slice(newline + 1);
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          const event = eventSchema.parse(JSON.parse(line.slice(6)));
          if (ttft === null && ["response.output_text.delta", "response.function_call_arguments.delta", "response.custom_tool_call_input.delta"].includes(event.type)) ttft = performance.now() - start;
          if (["response.completed", "response.failed", "response.incomplete"].includes(event.type)) terminal = event.response;
          if (event.type === "error") terminal = { status: "failed", error: event.error };
        }
      }
      return { response: terminal ?? { status: "failed", error: { code: "successful_terminal_missing" } }, ttftMs: ttft };
    };
    const browserRequest = async (id: string, history: JsonValue[] = []) => {
      const start = performance.now(), marker = `bench:${randomUUID()}`;
      try {
        const epoch = await prepare(id);
        const user = { role: "user", content: marker + " Synthetic offline task." };
        const body = { model, stream: true, reasoning: { effort: "high" }, input: [...history, user] };
        const { response, ttftMs } = await readResponse(await post("/v1/browser/responses", { protocolVersion: 1, profileId: id, profileEpoch: epoch,
          request: body, effectiveModel: model, effectiveReasoning: "high", transformedRequestSha256: sha256(JSON.stringify(body)) }, id), start);
        const completed = response.status === "completed";
        measurements.push({ elapsedMs: performance.now() - start, ttftMs, completed, code: completed ? null : safeCode(response.error?.code) });
        if (completed && response.output) history.push(user, ...response.output);
        return completed ? response.output : null;
      } catch (error) { measurements.push({ elapsedMs: performance.now() - start, ttftMs: null, completed: false, code: safeCode(error instanceof Error ? error.message : null) }); return null; }
    };
    const nativeSend = async (id: string, body: JsonObject, threadId: string, turnId: string, parentThreadId?: string, compact = false, signal?: AbortSignal) => {
      const start = performance.now(), now = Math.floor(Date.now() / 1000), agentName = parentThreadId ? "/root/child" : "/root";
      const request = { ...body, client_metadata: { "x-codex-turn-metadata": { request_kind: compact ? "compaction" : "turn", thread_id: threadId,
        turn_id: turnId, agent_name: agentName, ...(parentThreadId ? { parent_thread_id: parentThreadId, subagent_kind: "thread_spawn" } : {}),
        sandbox_mode: "workspace-write", workspaces: { [workspace]: {} } } } };
      const authority = { v: 1, aud: "9router-cgw", purpose: compact ? "compact" : "responses", clientId: "offline-benchmark", jti: randomUUID(), iat: now, exp: now + 60,
        method: "POST", path: compact ? "/v1/responses/compact" : "/v1/responses", bodySha256: sha256(JSON.stringify(request)), threadId, turnId, agentName,
        ...(parentThreadId ? { parentThreadId, subagentKind: "thread_spawn" } : {}), pathFlavor: "posix",
        environment: { cwd: workspace, roots: [workspace], writableRoots: [workspace], sandboxPolicy: { type: "workspaceWrite", networkAccess: false, writableRoots: [workspace] } } };
      const envelope = { protocolVersion: 1, profileId: id, profileEpoch: ownedRuntime.state.profile(id).epoch, request, authority,
        originalModel: `cgw/${model}`, effectiveModel: model, effectiveReasoning: "high", transformedRequestSha256: sha256(JSON.stringify(request)) };
      const { response, ttftMs } = await post(authority.path, envelope, id, signal).then(response => readResponse(response, start)).catch(error => {
        measurements.push({ elapsedMs: performance.now() - start, ttftMs: null, completed: false, code: safeCode(error instanceof Error ? error.message : null) });
        throw error;
      });
      const completed = compact ? Array.isArray(response.output) && response.output.length > 0 && !response.error : response.status === "completed";
      const taskCompleted = completed && !compact && !response.output?.some(item => item.type === "function_call" || item.type === "custom_tool_call");
      measurements.push({ elapsedMs: performance.now() - start, ttftMs, completed, taskCompleted, code: completed ? null : safeCode(response.error?.code) });
      assert(completed, "native_request_failed"); return response;
    };
    const bind = async (id: string, threadId: string) => {
      const response = await post("/v1/thread-bindings/resolve", { clientId: "offline-benchmark", threadId, candidateProfileIds: [id] }, id);
      assert(response.ok, "native_binding_failed"); await response.arrayBuffer();
    };
    if (scenario.name === "concurrent-tasks") {
      await Promise.all(Array.from({ length: scenario.concurrency }, (_, index) => browserRequest(profileIds[index % profileIds.length])));
    } else if (scenario.name === "stateless-rounds") {
      const history: JsonValue[] = [], sendsBefore = result.sends, newChatsBefore = result.newChats;
      for (let round = 0; round < options.rounds; round++) {
        const output = await browserRequest(profileIds[0], history);
        assert(output, "stateless_round_failed");
      }
      assert(result.sends - sendsBefore === options.rounds && result.newChats - newChatsBefore === options.rounds, "stateless_rounds_not_fresh_once_only");
    } else if (scenario.name === "idle-after-completion") {
      assert(await browserRequest(profileIds[0]), "idle_completion_failed");
      await snapshot("completed-before-idle"); await Bun.sleep(options.idleSeconds * 1000);
      await snapshot("after-idle");
      if (features.lazy && options.idleSeconds >= 330) assert(contexts.size === 0, "browser_idle_reclaim_failed");
    } else if (scenario.native) {
      const id = profileIds[0]; await prepare(id);
      const threadId = randomUUID(), turnId = randomUUID(), marker = `bench:${randomUUID()}`;
      await bind(id, threadId);
      const inputItems = [{ type: "message", role: "user", id: randomUUID(), content: marker + " Synthetic native task.", internal_chat_message_metadata_passthrough: { turn_id: turnId } }];
      const nativeBody = { model, stream: true, reasoning: { effort: "high" }, input: inputItems };
      const sendsBefore = result.sends;
      if (scenario.name === "native-tool-wait-child-continuation") {
        const tools = [{ type: "namespace", name: "fixture", tools: [{ type: "function", name: "read", description: "Synthetic file read", parameters: {
          type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] }, { type: "custom", name: "apply_patch", description: "Synthetic patch", format: { type: "text" } }];
        let body: JsonObject & { input: JsonValue[] } = { ...nativeBody, tools }, final = false, childRan = false; const delivered = new Set<string>();
        for (let round = 0; round < 5; round++) {
          const response = await nativeSend(id, body, threadId, turnId);
          assert(response.output, "native_output_missing");
          const calls = response.output.filter(item => item.type === "function_call" || item.type === "custom_tool_call");
          if (!calls.length) { final = true; break; }
          // Actual signed child inference is the external tool work. Parent retains
          // its browser owner and must release/reacquire its executing permit.
          if (!childRan) {
            const childThread = randomUUID(), childTurn = randomUUID(); await bind(id, childThread);
            await nativeSend(id, { ...nativeBody, input: [{ type: "message", role: "user", id: randomUUID(), content: `bench:${randomUUID()} Synthetic child work.`,
              internal_chat_message_metadata_passthrough: { turn_id: childTurn } }] }, childThread, childTurn, threadId); childRan = true;
          }
          const outputs = calls.map(call => {
            assert(call.call_id && !delivered.has(call.call_id), "native_tool_executed_twice"); delivered.add(call.call_id); result.nativeToolExecutions++;
            let output: string;
            if (call.type === "custom_tool_call") {
              assert(call.name === "apply_patch" && call.input === "*** Begin Patch\n*** Add File: synthetic-fixed.txt\n+fixed\n*** End Patch", "unexpected_native_patch");
              writeFileSync(join(workspace, "synthetic-fixed.txt"), "fixed\n", { mode: 0o600 });
              output = "Synthetic patch applied in the disposable workspace.";
            } else {
              assert(call.name === "read" && call.namespace === "fixture" && typeof call.arguments === "string", "unexpected_native_read");
              const argumentsValue = z.object({ path: z.literal("synthetic.txt") }).strict().parse(JSON.parse(call.arguments));
              output = readFileSync(join(workspace, argumentsValue.path), "utf8");
            }
            return { type: call.type === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output", call_id: call.call_id, output };
          });
          body = { ...body, input: [...body.input, ...response.output, ...outputs] };
        }
        assert(final && childRan && delivered.size === 2 && result.sends - sendsBefore === 2, "native_parent_child_continuation_failed");
        assert(readFileSync(join(workspace, "synthetic-fixed.txt"), "utf8") === "fixed\n", "native_local_tool_result_missing");
        if (features.resources) assert((result.waitingToolTurnsPeak ?? 0) > 0, "parent_external_tool_wait_not_observed");
        if (scenario.mode.adaptive) assert(Object.values(result.pollDelayCounts ?? {}).some(count => count > 0), "adaptive_dom_loop_not_observed");
      } else if (scenario.name === "native-compaction") {
        const original = await nativeSend(id, nativeBody, threadId, turnId);
        assert(original.output, "compaction_source_output_missing");
        const checkpoint = await nativeSend(id, { ...nativeBody, input: [...nativeBody.input, ...original.output], stream: false }, threadId, turnId, undefined, true);
        assert(checkpoint.output && result.sends - sendsBefore === 2 && result.mcpResults >= 1, "compaction_control_receipt_missing");
        const nextTurn = randomUUID();
        await nativeSend(id, { ...nativeBody, input: [...checkpoint.output, { type: "message", role: "user", id: randomUUID(), content: `bench:${randomUUID()} Continue synthetic checkpoint.`,
          internal_chat_message_metadata_passthrough: { turn_id: nextTurn } }] }, threadId, nextTurn);
        assert(result.sends - sendsBefore === 3, "compaction_continuation_duplicate_send");
      } else {
        const abort = new AbortController(); const requestStart = performance.now(), measurementStart = measurements.length;
        const { promise: submitted, resolve: sent } = Promise.withResolvers<void>(); requestsByMarker.set(marker, { sent });
        const pending = nativeSend(id, nativeBody, threadId, turnId, undefined, false, abort.signal);
        const timeout = setTimeout(() => abort.abort(), 30_000);
        await Promise.race([submitted, pending.then(() => { throw new Error("abort_fixture_finished_before_send"); })]);
        abort.abort();
        const canceled = await pending.then(() => false, () => true);
        clearTimeout(timeout); requestsByMarker.delete(marker); assert(canceled, "native_abort_not_observed");
        if (measurements.length === measurementStart) measurements.push({ elapsedMs: performance.now() - requestStart, ttftMs: null, completed: false, code: "expected_abort", expectedInterrupted: true });
        else measurements[measurementStart] = { ...measurements[measurementStart], completed: false, code: "expected_abort", expectedInterrupted: true };
        assert(result.sends - sendsBefore === 1, "abort_duplicate_or_missing_send");
        result.abortObservedAfterPhysicalSend = true;
      }
      const deadline = Date.now() + 30_000;
      while (chatGptTurnSessions.physicalWorkCount() && Date.now() < deadline) await Bun.sleep(25);
      assert(chatGptTurnSessions.physicalWorkCount() === 0, "native_physical_owner_not_settled");
    }
    await snapshot("scenario-finished");
    if (features.resources) {
      assert(capacityLimits, "normalized_runtime_capacity_limits_missing");
      assert(result.browserPeak <= capacityLimits.maxGlobalBrowsers && result.tabPeak <= capacityLimits.maxGlobalTabs && (result.executingTurnsPeak ?? 0) <= capacityLimits.maxGlobalTurns, "resource_cap_exceeded");
    }
    result.elapsedMs = performance.now() - started;
    result.completedTasks = measurements.filter(row => row.completed && row.taskCompleted !== false).length;
    result.failures = measurements.filter(row => !row.completed && !row.expectedInterrupted).length;
    result.expectedInterruptions = measurements.filter(row => row.expectedInterrupted).length;
    result.completedTasksPerSecond = result.elapsedMs > 0 ? result.completedTasks * 1000 / result.elapsedMs : null;
    const processMetrics = collector.sample();
    result.metrics = input.cgroup ? cgroupMeasurement(input.cgroup) : { ...processMetrics, cpuSeconds: processMetrics.cpuSeconds === null || initialCpu === null ? null : processMetrics.cpuSeconds - initialCpu };
    result.status = result.failures ? "failed" : "completed";
  } catch (error) { result.code = safeCode(error instanceof Error ? error.message : null); }
  finally {
    clearInterval(timer);
    result.completedTasks = measurements.filter(row => row.completed && row.taskCompleted !== false).length;
    result.failures = measurements.filter(row => !row.completed && !row.expectedInterrupted).length;
    result.expectedInterruptions = measurements.filter(row => row.expectedInterrupted).length;
    if (scenarioStarted !== null) result.elapsedMs = performance.now() - scenarioStarted;
    try {
      const measured = collector?.sample();
      if (!result.metrics) result.metrics = input.cgroup ? cgroupMeasurement(input.cgroup) : measured ? { ...measured,
        cpuSeconds: measured.cpuSeconds === null || initialCpu === null ? null : measured.cpuSeconds - initialCpu } : null;
      if (result.collectorUnavailable && !input.cgroup) result.metrics = { cpuSeconds: null, memoryBytes: null, memoryPeakBytes: null };
    } catch { result.metrics = null; }
    try {
      if (runtime) { const { chatGptTurnSessions } = await importSelected("src/adapters/chatgpt-web/turn-execution.ts"); chatGptTurnSessions.clear(); }
      for (const client of clients.values()) await client.close();
      await runtime?.close();
    } catch { result.status = "failed"; result.code = "owned_runtime_cleanup_failed"; }
    writeFileSync(join(root, "result.json"), JSON.stringify(result), { mode: 0o600 });
  }
}
function safeCode(value: unknown): string {
  // Never persist exception messages, transport payloads, keys, prompts or IDs.
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,95}$/.test(value) ? value : "benchmark_contract_failed";
}
if (process.argv[2] === "--cgroup-launcher") {
  const group = process.argv[3], rawArgs: unknown = JSON.parse(process.argv[4]);
  assert(group && isAbsolute(group) && /\/cgw-benchmark-[a-f0-9-]+$/.test(group) && Array.isArray(rawArgs), "invalid_owned_cgroup_launcher");
  const args = rawArgs.map((value: unknown) => { assert(typeof value === "string", "invalid_sandbox_argument"); return value; });
  writeFileSync(join(group, "cgroup.procs"), String(process.pid));
  const child = spawnSync("bwrap", args, { stdio: "inherit", env: process.env });
  process.exitCode = child.status ?? 1;
} else if (process.argv[2] === "--worker") await workerMain();
else await hostMain();
