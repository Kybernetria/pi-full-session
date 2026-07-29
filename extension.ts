import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProtocolNamespace, ensureProtocolFabric, parseProtocolManifest, registerProtocolManifest } from "@kybernetria/pi-protocol";
import { FullSessionService, loadConfig } from "./src/service.js";

const manifest = parseProtocolManifest(
  readFileSync(fileURLToPath(new URL("./pi.protocol.json", import.meta.url)), "utf8"),
);
const protocol = createProtocolNamespace(manifest);
const launchHandler = "launch";
protocol.handler(launchHandler);

export default function extension(_pi: ExtensionAPI): void {
  const fabric = ensureProtocolFabric();
  fabric.unregister(protocol.nodeId);
  registerProtocolManifest(fabric, {
    manifest,
    handlers: {
      [launchHandler]: async input => new FullSessionService(await loadConfig()).launch(input),
    },
  });
}
