import { ensureDirs, DATA_FILE } from "./paths.js";
import { createBunSqliteAdapter } from "./adapters/bunSqliteAdapter.js";

// Use global to survive Next.js dev hot-reload (module state resets on reload)
if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false };
const state = global._dbAdapter;

async function initAdapter() {
  ensureDirs();
  if (!process.versions.bun) {
    throw new Error(
      "[DB] bun:sqlite requires Bun runtime. Please run 9router with Bun (e.g. bun run dev / bun custom-server.js)."
    );
  }
  const adapter = await createBunSqliteAdapter(DATA_FILE);
  if (!state.logged) {
    console.log(`[DB] Driver: ${adapter.driver} | file: ${DATA_FILE}`);
    state.logged = true;
  }
  const { runMigrationOnce } = await import("./migrate.js");
  await runMigrationOnce(adapter);
  return adapter;
}

export async function getAdapter() {
  if (state.instance) return state.instance;
  if (!state.initPromise) {
    state.initPromise = initAdapter().then((a) => {
      state.instance = a;
      return a;
    });
  }
  return state.initPromise;
}

export function resetAdapterForTest() {
  try { state.instance?.close?.(); } catch {}
  state.instance = null;
  state.initPromise = null;
  state.logged = false;
}
