// Keep the historical schema version reserved without rewriting saved credentials,
// browser profiles, or legacy conversations. Runtime connections require a new
// upstream cookie login; profile selectors are not cookie credentials.
export default {
  version: 5,
  name: "chatgpt-web-runtime-profiles",
  up() {},
};
