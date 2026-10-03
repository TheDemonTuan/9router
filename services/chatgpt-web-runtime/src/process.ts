import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** SQLite's OS file lock is held for the service lifetime, independently of state quiescence. */
export class RuntimeSingletonLock {
  private lock?: Database;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, "runtime-owner.sqlite");
    const lock = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    try {
      lock.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(pid INTEGER); DELETE FROM owner;");
      lock.query("INSERT INTO owner(pid) VALUES(?)").run(process.pid);
      this.lock = lock;
    } catch {
      lock.close();
      throw new Error("CGW_DATA_DIR already has a runtime owner; Chromium was not opened");
    }
  }
  close(): void {
    if (!this.lock) return;
    this.lock.exec("ROLLBACK");
    this.lock.close(); this.lock = undefined;
  }
}
