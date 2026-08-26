// dsh-friendly-steps — host half.
//
// This plugin is presentation-only: every behavior lives in the browser half
// (lib/client.js). The host half exists because a dsh insert row resolves the
// package's "." export inside the host process first.

export const name = "friendly-steps";

export const inject = [];

export function apply() {
	// Nothing to do in the host process.
}
