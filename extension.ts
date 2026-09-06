import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  childLaunchProvenance,
  FULL_SESSION_PROVENANCE_ENTRY,
  readInheritedLaunchProvenance,
} from "./src/provenance.js";
import { registerFullSessionTools } from "./src/tools.js";

export default function extension(pi: ExtensionAPI): void {
  registerFullSessionTools(pi);
  pi.on("session_start", (_event, ctx) => {
    const inherited = readInheritedLaunchProvenance(process.env);
    if (!inherited) return;
    const alreadyRecorded = ctx.sessionManager.getEntries().some(entry =>
      entry.type === "custom" && entry.customType === FULL_SESSION_PROVENANCE_ENTRY &&
      typeof entry.data === "object" && entry.data !== null &&
      (entry.data as { launchId?: unknown }).launchId === inherited.launchId,
    );
    if (alreadyRecorded) return;
    try {
      // The child records the handoff in its own durable session. This is
      // metadata only: it does not add a monitor, control channel, or prompt.
      pi.appendEntry(FULL_SESSION_PROVENANCE_ENTRY, childLaunchProvenance(inherited, ctx));
    } catch (error) {
      // A provenance write must not prevent the interactive child from starting.
      console.error(`[pi-full-session] could not record launch provenance: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
