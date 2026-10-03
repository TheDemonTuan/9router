import { loadCompanionConfig } from "./main";

if (import.meta.main) {
  const args = process.argv.slice(2);
  const fields: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key || !["--thread-id", "--turn-id"].includes(key) || !value || fields[key]) throw new Error("Usage: companion:interrupt --thread-id <id> --turn-id <id>");
    fields[key] = value;
  }
  if (!fields["--thread-id"] || !fields["--turn-id"]) throw new Error("Exact native thread and turn IDs required");
  const configFile = process.env.CGW_COMPANION_CONFIG_FILE;
  if (!configFile) throw new Error("CGW_COMPANION_CONFIG_FILE is required");
  const config = loadCompanionConfig(configFile);
  const response = await fetch(`http://127.0.0.1:${config.listenPort}/v1/cgw/interrupt-turn`, {
    method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
    body: JSON.stringify({ threadId: fields["--thread-id"], turnId: fields["--turn-id"] }),
  });
  if (!response.ok) throw new Error(`Targeted interrupt rejected (${response.status})`);
  const result = await response.json();
  console.info(JSON.stringify({ cancelled: result.cancelled }));
}
