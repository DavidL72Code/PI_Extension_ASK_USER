// Live-check helper only; not part of the ask_user extension.
//
// Pi requests the model's full output limit (about 235k tokens for the default
// OpenRouter model). A key with a spending limit below that is rejected with
// HTTP 402 before the model runs. This caps the requested output tokens so the
// live checks fit the key's limit. Override with LIVE_CHECK_MAX_TOKENS.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CAP = Number(process.env.LIVE_CHECK_MAX_TOKENS ?? 8192);
const FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"];

export default function capMaxTokens(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) => {
		if (typeof event.payload !== "object" || event.payload === null) return undefined;
		const payload = { ...(event.payload as Record<string, unknown>) };
		for (const field of FIELDS) {
			const value = payload[field];
			if (typeof value === "number" && value > CAP) payload[field] = CAP;
		}
		return payload;
	});
}
