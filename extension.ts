import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFullSessionTools } from "./src/tools.js";

export default function extension(pi: ExtensionAPI): void {
  registerFullSessionTools(pi);
}
