import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureProtocolFabric } from "@kybernetria/pi-protocol/core";
import { parseProtocolManifest } from "@kybernetria/pi-protocol/contract";
import { FullSessionService, loadConfig } from "./src/service.js";

const definition = parseProtocolManifest(
  readFileSync(fileURLToPath(new URL("./pi.protocol.json", import.meta.url)), "utf8"),
  { allowLegacyV02: false },
);
const launchHandler = "launch";

export default function extension(pi: ExtensionAPI): void {
  const fabric = ensureProtocolFabric();
  const registration = fabric.install(definition, {
    handlers: {
      [launchHandler]: async input => new FullSessionService(await loadConfig()).launch(input),
    },
  }, {
    packageId: "@kybernetria/pi-full-session",
    packageVersion: "0.2.0",
    sourcePath: fileURLToPath(new URL(".", import.meta.url)),
  });
  pi.on("session_shutdown", async () => { await registration.dispose(); });
}
