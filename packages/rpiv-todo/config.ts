import type { GuidanceFields } from "@juicesharp/rpiv-config";
import { configPath, loadJsonConfig, validateGuidanceFields } from "@juicesharp/rpiv-config";

const CONFIG_PATH = configPath("rpiv-todo");

interface TodoConfig {
	guidance?: GuidanceFields;
	maxWidgetLines?: number;
	/** Key spec for overlay collapse/expand, e.g. `ctrl+shift+t` or `alt+o`.
	 *  `"off"` disables the shortcut. Validated in `resolveCollapseKey`. */
	collapseKey?: string;
}

const DEFAULT_MAX_WIDGET_LINES = 12;

/** Default collapse/expand key when `collapseKey` is missing/empty/blank/invalid. */
export const DEFAULT_COLLAPSE_KEY = "ctrl+shift+t";

/** Sentinel value for `collapseKey` that disables the collapse shortcut entirely. */
export const COLLAPSE_KEY_OFF = "off";

export function loadConfig(): TodoConfig {
	return loadJsonConfig<TodoConfig>(CONFIG_PATH);
}

export { validateGuidanceFields };

export function getMaxWidgetLines(): number {
	const configured = loadConfig().maxWidgetLines;
	return typeof configured === "number" && configured > 0 ? configured : DEFAULT_MAX_WIDGET_LINES;
}

// Named keys accepted by pi-tui's `matchesKey` (keys.js switch on the parsed
// base key). parseKeyId lowercases the id before matching, so lowercase is canonical.
const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

/** Validate a collapse-key spec against pi-tui's KeyId grammar (verbatim port
 *  from rpiv-ask-user-question). A loose check is not enough — pi-tui's
 *  `parseKeyId` takes the LAST `+`-part as the key and ignores unknown parts,
 *  so a typo like `ctr+]` would silently match every bare `]` keypress. */
export function isValidCollapseKeySpec(spec: string): boolean {
	if (!spec) return false;
	if (spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
	const parts = spec.split("+");
	const base = parts[parts.length - 1] ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size) return false;
	if (!modifiers.every((m) => MODIFIERS.has(m))) return false;
	return base.length === 1 ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base) : SPECIAL_KEYS.has(base);
}

/** Resolve the collapse/expand key from config, read fresh on every call
 *  (per-render / per-registration — no `/reload`). Returns DEFAULT_COLLAPSE_KEY
 *  when missing/empty/invalid, COLLAPSE_KEY_OFF when set to the sentinel, or
 *  the lowercased validated spec. */
export function resolveCollapseKey(): string {
	const configured = loadConfig().collapseKey;
	const raw = typeof configured === "string" ? configured.trim().toLowerCase() : undefined;
	if (raw === undefined || raw === "") return DEFAULT_COLLAPSE_KEY;
	if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}
