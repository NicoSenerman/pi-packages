import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getGrokAuthCredentials } from "./xai/auth";
import { XAI_API_BASE_URL, XAI_PROVIDER_ID } from "./xai/constants";
import { MODELS } from "./xai/models";
import { createXaiOAuth } from "./xai/oauth";
import { streamSimpleXaiResponses } from "./xai/responses";

// Stripped fork: keeps only the xAI OAuth provider + model catalog.
// Removed: the 9 custom xai_* agent tools and the Cursor/Grok CLI tool-compat
// shims (registerXaiTools + syncCursorToolShimsForModel event hooks) that the
// upstream npm package registers alongside the provider. Those added tool-call
// surface area + system-prompt bloat; this fork intentionally drops them.
export default function (pi: ExtensionAPI) {
  pi.registerProvider(XAI_PROVIDER_ID, {
    name: "xAI (OAuth)",
    baseUrl: XAI_API_BASE_URL,
    api: "xai-responses",
    models: MODELS as any,
    authHeader: true,
    streamSimple: streamSimpleXaiResponses as any,
    oauth: createXaiOAuth({
      getExistingCredentials: getGrokAuthCredentials,
    }) as any,
  });
}
