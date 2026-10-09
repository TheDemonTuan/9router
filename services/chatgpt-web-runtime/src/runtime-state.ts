import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ProfileSettings } from "./config";
import { DEFAULT_PROFILE_SETTINGS, profileSettingsSchema } from "./config";
import { validateProfileId } from "../protocol.js";
import type { AuthorityClaims } from "./authority";

export class RuntimeStateError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
export interface RuntimeProfile {
  profileId: string; epoch: string; revision: number; settings: ProfileSettings; accountFingerprint: string | null;
}
export interface ThreadBinding { profileId: string; profileEpoch: string; status: "active" | "interrupted" | "legacy_unavailable"; }
export interface DeploymentFence { operationId: string; state: "draining" | "quiesced"; }
interface ProfileRow { profile_id: string; epoch: string; revision: number; settings_json: string; account_fingerprint: string | null; }
export class RuntimeState {
  private db: Database | undefined;
  private fenceSnapshot: DeploymentFence | null = null;
  readonly accountSalt: Uint8Array;
  private quiescedProfiles: RuntimeProfile[] | undefined;
  private acceptedCountSnapshot = 0;
  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    this.open();
    const existing = this.store.query("SELECT value FROM runtime_meta WHERE key='account_salt'").get() as { value: string } | null;
    if (existing ? !/^[a-f0-9]{64}$/.test(existing.value) : this.listProfiles().some(profile => profile.accountFingerprint !== null)) {
      this.close(); throw new RuntimeStateError("state_schema_invalid", "Account identity salt is missing or invalid", 503);
    }
    const salt = existing?.value || randomBytes(32).toString("hex");
    if (!existing) this.store.query("INSERT INTO runtime_meta(key,value) VALUES('account_salt',?)").run(salt);
    this.accountSalt = Buffer.from(salt, "hex");
    // Accepted work cannot be resurrected after crash: browser Send/tool effects are ambiguous.
    this.store.transaction(() => {
      this.store.exec("UPDATE request_claims SET status='interrupted' WHERE status='accepted'");
      this.store.exec("UPDATE turn_ledger SET status='interrupted' WHERE status='accepted'");
    })();
  }
  private get store(): Database {
    if (!this.db) throw new RuntimeStateError("runtime_quiesced", "Runtime state is closed");
    return this.db;
  }
  open(): void {
    if (this.db) return;
    this.db = new Database(join(this.dataDir, "runtime.sqlite"), { create: true, strict: true });
    chmodSync(join(this.dataDir, "runtime.sqlite"), 0o600);
    try {
      const version = this.db.query("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version !== 0 && version.user_version !== 1) throw new RuntimeStateError("state_schema_unsupported", "Runtime state schema is not compatible", 503);
      const columns: Record<string, string[]> = {
        profiles: ["profile_id", "epoch", "revision", "settings_json", "account_fingerprint"],
        thread_bindings: ["client_id", "thread_id", "profile_id", "profile_epoch", "status"],
        request_claims: ["client_id", "jti", "body_sha256", "expires_at", "status"],
        runtime_meta: ["key", "value"],
        turn_ledger: ["profile_id", "profile_epoch", "client_id", "thread_id", "turn_id", "model_identity", "status"],
      };
      const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
      if (version.user_version === 0 && tables.length > 0
        || version.user_version === 1 && (tables.length !== Object.keys(columns).length || tables.some(table => !Object.hasOwn(columns, table.name)))) {
        throw new RuntimeStateError("state_schema_invalid", "Runtime table schema is incomplete", 503);
      }
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      if (version.user_version === 0) this.db.exec(`
        CREATE TABLE profiles(profile_id TEXT PRIMARY KEY,epoch TEXT NOT NULL,revision INTEGER NOT NULL,settings_json TEXT NOT NULL,account_fingerprint TEXT);
        CREATE TABLE thread_bindings(client_id TEXT NOT NULL,thread_id TEXT NOT NULL,profile_id TEXT NOT NULL,profile_epoch TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','interrupted','legacy_unavailable')),PRIMARY KEY(client_id,thread_id));
        CREATE TABLE request_claims(client_id TEXT NOT NULL,jti TEXT NOT NULL,body_sha256 TEXT NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('accepted','settled','interrupted')),PRIMARY KEY(client_id,jti));
        CREATE TABLE runtime_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE turn_ledger(profile_id TEXT NOT NULL,profile_epoch TEXT NOT NULL,client_id TEXT NOT NULL,thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,model_identity TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('accepted','settled','interrupted')),PRIMARY KEY(profile_id,profile_epoch,client_id,thread_id,turn_id));
        PRAGMA user_version=1;`);
      for (const [table, expected] of Object.entries(columns)) {
        const actual = this.db.query(`PRAGMA table_info(${table})`).all() as { name: string; type: string; pk: number }[];
        const primaryKeys = table === "profiles" || table === "runtime_meta" ? 1 : table === "turn_ledger" ? 5 : 2;
        if (actual.length !== expected.length || actual.some((column, index) => column.name !== expected[index]
          || column.type !== (["revision", "expires_at"].includes(column.name) ? "INTEGER" : "TEXT")
          || column.pk !== (index < primaryKeys ? index + 1 : 0))) throw new RuntimeStateError("state_schema_invalid", "Runtime table schema is invalid", 503);
      }
      const fence = this.db.query("SELECT value FROM runtime_meta WHERE key='deployment_fence'").get() as { value: string } | null;
      const parsed = fence ? JSON.parse(fence.value) : null;
      if (fence && (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 2
        || typeof parsed.operationId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(parsed.operationId)
        || !["draining", "quiesced"].includes(parsed.state))) throw new Error("Invalid fence");
      this.fenceSnapshot = parsed;
      this.acceptedRequestCount();
      this.listProfiles();
    } catch (error) {
      this.db.close(); this.db = undefined;
      if (error instanceof RuntimeStateError) throw error;
      throw new RuntimeStateError("state_schema_invalid", "Runtime state metadata or schema is invalid", 503);
    }
  }
  listProfiles(): RuntimeProfile[] {
    if (this.quiescedProfiles && !this.db) return structuredClone(this.quiescedProfiles);
    const rows = this.store.query("SELECT * FROM profiles ORDER BY profile_id").all() as ProfileRow[];
    return rows.map(row => this.decodeProfile(row));
  }
  profile(profileId: string): RuntimeProfile {
    validateProfileId(profileId);
    if (this.quiescedProfiles && !this.db) {
      const profile = this.quiescedProfiles.find(profile => profile.profileId === profileId);
      if (!profile) throw new RuntimeStateError("profile_not_found", "Profile does not exist", 404);
      return structuredClone(profile);
    }
    const row = this.store.query("SELECT * FROM profiles WHERE profile_id=?").get(profileId) as ProfileRow | null;
    if (!row) throw new RuntimeStateError("profile_not_found", "Profile does not exist", 404);
    return this.decodeProfile(row);
  }
  private decodeProfile(row: ProfileRow): RuntimeProfile {
    validateProfileId(row.profile_id);
    if (!row.epoch || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new RuntimeStateError("state_schema_invalid", "Invalid profile identity", 503);
    return { profileId: row.profile_id, epoch: row.epoch, revision: row.revision,
      settings: profileSettingsSchema.parse(JSON.parse(row.settings_json)), accountFingerprint: row.account_fingerprint };
  }
  createProfile(profileId: string): RuntimeProfile {
    validateProfileId(profileId);
    if (this.fence()) throw new RuntimeStateError("runtime_draining", "Profile mutation denied while drained", 503);
    const result = this.store.query("INSERT OR IGNORE INTO profiles VALUES(?,?,1,?,NULL)").run(profileId, randomUUID(), JSON.stringify(DEFAULT_PROFILE_SETTINGS));
    if (!result.changes) throw new RuntimeStateError("profile_exists", "Profile already exists");
    return this.profile(profileId);
  }
  patchProfile(profileId: string, revision: number, settings: ProfileSettings): RuntimeProfile {
    if (this.fence()) throw new RuntimeStateError("runtime_draining", "Profile mutation denied while drained", 503);
    settings = profileSettingsSchema.parse(settings);
    const update = this.store.query("UPDATE profiles SET revision=revision+1,settings_json=? WHERE profile_id=? AND revision=?").run(JSON.stringify(settings), profileId, revision);
    if (!update.changes) throw new RuntimeStateError("profile_revision_conflict", "Profile revision changed");
    return this.profile(profileId);
  }
  activeTurnScopes(profileId: string, turnId: string): { clientId: string; threadId: string }[] {
    const profile = this.profile(profileId);
    return this.store.query("SELECT client_id AS clientId,thread_id AS threadId FROM turn_ledger WHERE profile_id=? AND profile_epoch=? AND turn_id=? AND status='accepted'").all(profileId, profile.epoch, turnId) as { clientId: string; threadId: string }[];
  }
  observeAccount(profileId: string, fingerprint: string, expectedRevision?: number): RuntimeProfile {
    this.store.transaction(() => {
      const profile = this.profile(profileId);
      if (expectedRevision !== undefined && expectedRevision !== profile.revision) throw new RuntimeStateError("profile_revision_conflict", "Stale account probe discarded");
      if (profile.accountFingerprint === fingerprint) return;
      const epoch = profile.accountFingerprint ? randomUUID() : profile.epoch;
      this.store.query("UPDATE profiles SET epoch=?,revision=revision+1,account_fingerprint=? WHERE profile_id=?").run(epoch, fingerprint, profileId);
      if (epoch !== profile.epoch) {
        this.store.query("UPDATE thread_bindings SET status='interrupted' WHERE profile_id=? AND profile_epoch=?").run(profileId, profile.epoch);
        this.store.query("UPDATE turn_ledger SET status='interrupted' WHERE profile_id=? AND profile_epoch=?").run(profileId, profile.epoch);
      }
    })();
    return this.profile(profileId);
  }
  binding(clientId: string, threadId: string): ThreadBinding | null {
    const row = this.store.query("SELECT profile_id,profile_epoch,status FROM thread_bindings WHERE client_id=? AND thread_id=?").get(clientId, threadId) as { profile_id: string; profile_epoch: string; status: ThreadBinding["status"] } | null;
    return row ? { profileId: row.profile_id, profileEpoch: row.profile_epoch, status: row.status } : null;
  }
  resolveBinding(options: { clientId: string; threadId: string; candidateProfileIds: string[]; requestedProfileId?: string; ready: (profileId: string) => boolean }): ThreadBinding {
    return this.store.transaction(() => {
      const existing = this.binding(options.clientId, options.threadId);
      if (existing) {
        if (existing.status !== "active" || this.profile(existing.profileId).epoch !== existing.profileEpoch) throw new RuntimeStateError("turn_interrupted", "Bound profile epoch or conversation is no longer active");
        if (options.requestedProfileId && options.requestedProfileId !== existing.profileId) throw new RuntimeStateError("profile_mismatch", "Explicit profile differs from existing binding");
        if (!options.candidateProfileIds.includes(existing.profileId)) throw new RuntimeStateError("profile_unavailable", "No active connection exists for bound profile");
        return existing;
      }
      if (this.fence()) throw new RuntimeStateError("runtime_draining", "New thread binding denied while drained", 503);
      const candidate = options.candidateProfileIds.find(id => (!options.requestedProfileId || id === options.requestedProfileId) && options.ready(id));
      if (!candidate) throw new RuntimeStateError("profile_unavailable", "No ready candidate profile");
      const profile = this.profile(candidate);
      this.store.query("INSERT INTO thread_bindings VALUES(?,?,?,?, 'active')").run(options.clientId, options.threadId, candidate, profile.epoch);
      return { profileId: candidate, profileEpoch: profile.epoch, status: "active" } as ThreadBinding;
    })();
  }
  assertCanAdmit(claims: AuthorityClaims, profileId: string, profileEpoch: string, modelIdentity: string, continuation: boolean): void {
    const binding = this.binding(claims.clientId, claims.threadId);
    if (!binding || binding.status !== "active" || binding.profileId !== profileId || binding.profileEpoch !== profileEpoch || this.profile(profileId).epoch !== profileEpoch) throw new RuntimeStateError("profile_mismatch", "Request does not match durable profile binding");
    const turn = this.store.query("SELECT status,model_identity FROM turn_ledger WHERE profile_id=? AND profile_epoch=? AND client_id=? AND thread_id=? AND turn_id=?").get(profileId, profileEpoch, claims.clientId, claims.threadId, claims.turnId) as { status: string; model_identity: string } | null;
    if (turn?.status === "interrupted") throw new RuntimeStateError("turn_interrupted", "Turn state was interrupted; ambiguous effects are not replayed");
    if (turn && turn.model_identity !== modelIdentity) throw new RuntimeStateError("model_scope_mismatch", "Turn model identity changed");
    if (this.fence() && (!continuation || turn?.status !== "accepted")) throw new RuntimeStateError("runtime_draining", "New browser turn denied while drained", 503);
    if (this.store.query("SELECT 1 FROM request_claims WHERE client_id=? AND jti=?").get(claims.clientId, claims.jti))
      throw new RuntimeStateError("authority_replayed", "Authority has already been consumed");
  }
  admit(claims: AuthorityClaims, profileId: string, profileEpoch: string, modelIdentity: string, continuation: boolean): void {
    this.store.transaction(() => {
      // Recheck inside the mutation transaction; a preflight never consumes authority.
      this.assertCanAdmit(claims, profileId, profileEpoch, modelIdentity, continuation);
      const claim = this.store.query("INSERT OR IGNORE INTO request_claims VALUES(?,?,?,?, 'accepted')").run(claims.clientId, claims.jti, claims.bodySha256, claims.exp);
      if (!claim.changes) throw new RuntimeStateError("authority_replayed", "Authority has already been consumed");
      this.store.query("INSERT INTO runtime_meta(key,value) VALUES('accepted_request_count','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run();
      this.store.query("INSERT OR IGNORE INTO turn_ledger VALUES(?,?,?,?,?,?, 'accepted')").run(profileId, profileEpoch, claims.clientId, claims.threadId, claims.turnId, modelIdentity);
    })();
  }
  consumeInterrupt(claims: AuthorityClaims): void {
    const claim = this.store.query("INSERT OR IGNORE INTO request_claims VALUES(?,?,?,?, 'accepted')").run(claims.clientId, claims.jti, claims.bodySha256, claims.exp);
    if (!claim.changes) throw new RuntimeStateError("authority_replayed", "Authority has already been consumed");
  }
  settleClaim(clientId: string, jti: string, interrupted = false): void {
    this.store.query("UPDATE request_claims SET status=? WHERE client_id=? AND jti=? AND status!='interrupted'").run(interrupted ? "interrupted" : "settled", clientId, jti);
  }
  settleTurn(profileId: string, profileEpoch: string, clientId: string, threadId: string, turnId: string, interrupted = false): void {
    this.store.query("UPDATE turn_ledger SET status=? WHERE profile_id=? AND profile_epoch=? AND client_id=? AND thread_id=? AND turn_id=? AND status!='interrupted'").run(interrupted ? "interrupted" : "settled", profileId, profileEpoch, clientId, threadId, turnId);
  }
  fence(): DeploymentFence | null { return this.fenceSnapshot ? { ...this.fenceSnapshot } : null; }
  acceptedRequestCount(): number {
    if (!this.db) return this.acceptedCountSnapshot;
    const value = this.store.query("SELECT value FROM runtime_meta WHERE key='accepted_request_count'").get() as { value: string } | null;
    const count = Number(value?.value || 0);
    if (!Number.isSafeInteger(count) || count < this.acceptedCountSnapshot || !/^(0|[1-9][0-9]*)$/.test(value?.value || "0")) throw new RuntimeStateError("state_schema_invalid", "Accepted request ledger is invalid", 503);
    this.acceptedCountSnapshot = count;
    return count;
  }
  assertFenceOwner(operationId: string): void {
    if (this.fenceSnapshot?.operationId !== operationId) throw new RuntimeStateError("deployment_operation_conflict", "Matching operation required");
  }
  drain(operationId: string): DeploymentFence {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(operationId)) throw new RuntimeStateError("invalid_operation", "Invalid deployment operation ID", 400);
    if (this.fenceSnapshot && this.fenceSnapshot.operationId !== operationId) throw new RuntimeStateError("deployment_operation_conflict", "Another operation owns the fence");
    if (!this.fenceSnapshot) {
      this.store.query("INSERT INTO runtime_meta(key,value) VALUES('deployment_fence',?)").run(JSON.stringify({ operationId, state: "draining" }));
      this.fenceSnapshot = { operationId, state: "draining" };
    }
    return this.fenceSnapshot;
  }
  quiesce(operationId: string): void {
    if (this.fenceSnapshot?.operationId !== operationId) throw new RuntimeStateError("deployment_operation_conflict", "Matching operation required");
    if (this.fenceSnapshot.state === "quiesced" && !this.db) return;
    this.quiescedProfiles = this.listProfiles();
    this.acceptedCountSnapshot = this.acceptedRequestCount();
    this.store.query("UPDATE runtime_meta SET value=? WHERE key='deployment_fence'").run(JSON.stringify({ operationId, state: "quiesced" }));
    this.store.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.store.close(); this.db = undefined;
    this.fenceSnapshot = { operationId, state: "quiesced" };
  }
  async resume(operationId: string, initialize: () => Promise<void>): Promise<void> {
    this.assertFenceOwner(operationId);
    this.open();
    await initialize();
    this.assertFenceOwner(operationId);
    this.store.query("DELETE FROM runtime_meta WHERE key='deployment_fence'").run();
    this.fenceSnapshot = null;
    this.quiescedProfiles = undefined;
  }
  close(): void {
    if (!this.db) return;
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close(); this.db = undefined;
  }
}
