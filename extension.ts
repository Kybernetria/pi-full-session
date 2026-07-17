import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureProtocolFabric, registerProtocolManifest, type PiProtocolManifest } from "@kybernetria/pi-protocol";
import { FullSessionService, loadConfig } from "./src/service.js";
const manifest=JSON.parse(readFileSync(new URL("./pi.protocol.json",import.meta.url),"utf8")) as PiProtocolManifest;
export default function extension(_pi:ExtensionAPI){const fabric=ensureProtocolFabric();fabric.unregister("pi_full_session");const service=async()=>new FullSessionService(fabric,await loadConfig());registerProtocolManifest(fabric,{manifest,handlers:{launch:async i=>(await service()).launch(i),launch_worktree:async i=>(await service()).worktree(i),status:async i=>(await service()).status(i),focus:async i=>(await service()).control("focus",i),send_input:async i=>(await service()).control("send_input",i),stop:async i=>(await service()).control("stop",i)}})}
