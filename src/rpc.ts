/**
 * Portable typed RPC contract shared by the model-router server plugin, TUI,
 * and external clients. JSON Schema output is intentionally conservative:
 * validation happens again in the server through `config.parseSettingsLayer`.
 */

import { Rpc } from "@opencode/plugin/rpc";

const jsonObject = {
  type: "object",
  additionalProperties: true,
} as const;

/**
 * RPC methods exposed by the server plugin under id `opencode-model-router`.
 */
export const ModelRouterRpc = Rpc.define({
  id: "opencode-model-router",
  methods: {
    getSettings: {
      input: jsonObject,
      output: jsonObject,
    },
    updateSettings: {
      input: {
        type: "object",
        properties: { patch: jsonObject },
        required: ["patch"],
        additionalProperties: false,
      },
      output: jsonObject,
    },
    listModels: {
      input: jsonObject,
      output: {
        type: "object",
        properties: {
          data: { type: "array" },
        },
        required: ["data"],
        additionalProperties: false,
      },
    },
    getStatus: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: jsonObject,
    },
  },
  events: {
    settingsChanged: { schema: jsonObject },
    statusChanged: { schema: jsonObject },
  },
});
