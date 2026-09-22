export default {
  id: "chatgpt-web",
  priority: 31,
  alias: "cgw",
  uiAlias: "cgw",
  display: {
    name: "ChatGPT Web",
    icon: "language",
    color: "#10A37F",
    website: "https://github.com/miuuyy/codex-chatgpt-web",
    notice: {
      message: "Unofficial local browser bridge. Provision and secure the bridge on the same host before connecting.",
    },
  },
  category: "localBridge",
  authType: "bridge",
  hasProviderSpecificData: true,
  transport: {
    format: "openai-responses",
    forceStream: true,
    noAuth: true,
  },
  models: [],
  serviceKinds: ["llm"],
};
