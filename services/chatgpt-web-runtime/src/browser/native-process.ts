import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

interface OwnedNativeProcess { pid: number; grouped: boolean; }

/** Only this spawn's process group or uniquely marked descendants may be signalled. */
export class NativeBrowserProcess {
  private stopping = false;
  private closing?: Promise<void>;
  private constructor(readonly child: ChildProcess, private readonly grouped: boolean, private readonly owner: string, private readonly display?: string) {}

  static async launch(executable: string, directory: string, display: string | undefined, startUrl: string,
    onUnexpectedExit?: () => void): Promise<NativeBrowserProcess> {
    const grouped = process.platform === "linux";
    const owner = `CGW_NATIVE_BROWSER_OWNER=${randomUUID()}`;
    const child = spawn(executable, [
      `--user-data-dir=${directory}`, "--no-first-run", "--no-default-browser-check",
      "--window-size=1280,900", startUrl,
    ], { env: { ...process.env, CGW_NATIVE_BROWSER_OWNER: owner.slice(owner.indexOf("=") + 1), ...(display ? { DISPLAY: display } : {}) }, stdio: "ignore", shell: false, detached: grouped });
    const owned = new NativeBrowserProcess(child, grouped, owner, display);
    child.once("exit", () => { if (!owned.stopping) onUnexpectedExit?.(); });
    try {
      await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("spawn", resolve); });
      if (!owned.running) throw new Error("Human login browser exited during startup");
      return owned;
    } catch (error) {
      await owned.close();
      throw error;
    }
  }

  get running(): boolean { return this.child.pid !== undefined && this.child.exitCode === null && this.child.signalCode === null; }

  private liveProcesses(): OwnedNativeProcess[] {
    if (!this.grouped || !this.child.pid) return this.running ? [{ pid: this.child.pid!, grouped: false }] : [];
    const live: OwnedNativeProcess[] = [];
    // Ignore zombies awaiting container init's reap. The inherited random marker
    // also identifies owned helpers that detach/reparent out of Chrome's group.
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
        if (fields[0] === "Z" || fields[0] === "X") continue;
        const grouped = Number(fields[2]) === this.child.pid;
        if (grouped || readFileSync(`/proc/${entry}/environ`, "utf8").split("\0").includes(this.owner)) {
          live.push({ pid: Number(entry), grouped });
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ESRCH" && code !== "EACCES" && code !== "EPERM") throw error;
      }
    }
    return live;
  }

  private signal(signal: NodeJS.Signals, owned?: readonly OwnedNativeProcess[]): void {
    if (!this.child.pid) return;
    const send = (pid: number) => {
      try { process.kill(pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    if (!owned) { if (this.running) this.child.kill(signal); return; }
    if (this.grouped && owned.some(child => child.grouped)) send(-this.child.pid);
    for (const child of owned) if (!child.grouped) {
      // Recheck the unique token before signalling a detached PID from a snapshot.
      if (this.grouped) {
        try { if (!readFileSync(`/proc/${child.pid}/environ`, "utf8").split("\0").includes(this.owner)) continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") continue; throw error; }
      }
      send(child.pid);
    }
  }

  private requestWindowClose(owned: readonly OwnedNativeProcess[]): Promise<boolean> {
    if (!this.grouped || !this.display || !this.running) return Promise.resolve(false);
    const pids = [...new Set([this.child.pid, ...owned.map(p => p.pid)].filter((p): p is number => typeof p === "number" && p > 1))].map(String);
    if (!pids.length) return Promise.resolve(false);
    const helper = spawn("python3", [join(import.meta.dir, "../../scripts/close-native-browser.py"), this.display, ...pids], { stdio: "ignore", shell: false });
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => { helper.kill("SIGKILL"); }, 5000);
    helper.once("error", () => { clearTimeout(timer); resolve(false); });
    helper.once("exit", code => { clearTimeout(timer); resolve(code === 0); });
    return promise;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    this.closing = (async () => {
      // SIGTERM can exit Chrome without saving recently issued cookies. Ask the
      // exact owned desktop windows to close normally before escalating signals.
      let owned = this.liveProcesses();
      const requested = await this.requestWindowClose(owned);
      owned = this.liveProcesses();
      let deadline = Date.now() + (requested ? 7000 : 3000);
      while (owned.length && Date.now() < deadline) { await Bun.sleep(25); owned = this.liveProcesses(); }
      if (owned.length) this.signal("SIGTERM", owned);
      deadline = Date.now() + 2000;
      while (owned.length && Date.now() < deadline) { await Bun.sleep(25); owned = this.liveProcesses(); }
      deadline = Date.now() + 2000;
      while (owned.length && Date.now() < deadline) {
        this.signal("SIGKILL", owned);
        await Bun.sleep(25); owned = this.liveProcesses();
      }
      if (owned.length) throw new Error("Owned human browser processes did not settle");
      // Observe Bun's child exit before releasing directory ownership, also bounded.
      if (this.running) await new Promise<void>((resolve, reject) => {
        const exited = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { this.child.off("exit", exited); reject(new Error("Owned human browser exit was not observed")); }, 2000);
        this.child.once("exit", exited);
      });
    })();
    return this.closing;
  }
}
