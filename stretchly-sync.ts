import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface BreakConfig {
	/** Interval between micro breaks in ms */
	microbreakIntervalMs: number;
	/** Number of micro breaks before a long break */
	longBreakAfter: number;
	/** Enable file-based debug logging to ~/.omp/agent/stretchly-sync.log */
	debug: boolean;
}

const DEFAULTS: BreakConfig = {
	microbreakIntervalMs: 10 * 60 * 1_000,
	longBreakAfter: 9,
	debug: false,
};

/**
 * Loads break schedule config.
 *
 * Priority (highest wins):
 *   1. ~/.omp/agent/stretchly-sync.json  (local override)
 *   2. %APPDATA%/Stretchly/config.json   (Stretchly's own config)
 *   3. Built-in defaults (10 min interval, long break after 9 micros)
 *
 * Local override shape:
 *   { "microbreakIntervalMs": 600000, "longBreakAfter": 9, "debug": true }
 */
function loadConfig(log: (msg: string) => void): BreakConfig {
	const config = { ...DEFAULTS };

	const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
	const stretchlyPath = join(appData, "Stretchly", "config.json");
	if (existsSync(stretchlyPath)) {
		try {
			const raw = JSON.parse(readFileSync(stretchlyPath, "utf8"));
			if (typeof raw.microbreakInterval === "number" && raw.microbreakInterval > 0) {
				config.microbreakIntervalMs = raw.microbreakInterval;
			}
			if (typeof raw.breakInterval === "number" && raw.breakInterval > 0) {
				config.longBreakAfter = raw.breakInterval;
			}
			log(`stretchly config: interval=${config.microbreakIntervalMs}ms, longBreakAfter=${config.longBreakAfter}`);
		} catch (e: any) {
			log(`stretchly config read error: ${e.message}`);
		}
	}

	const overridePath = join(homedir(), ".omp", "agent", "stretchly-sync.json");
	if (existsSync(overridePath)) {
		try {
			const raw = JSON.parse(readFileSync(overridePath, "utf8"));
			if (typeof raw.microbreakIntervalMs === "number" && raw.microbreakIntervalMs > 0) {
				config.microbreakIntervalMs = raw.microbreakIntervalMs;
			}
			if (typeof raw.longBreakAfter === "number" && raw.longBreakAfter > 0) {
				config.longBreakAfter = raw.longBreakAfter;
			}
			if (typeof raw.debug === "boolean") {
				config.debug = raw.debug;
			}
			log(`local override: interval=${config.microbreakIntervalMs}ms, longBreakAfter=${config.longBreakAfter}`);
		} catch (e: any) {
			log(`local override read error: ${e.message}`);
		}
	}

	return config;
}

// ---------------------------------------------------------------------------
// Stretchly helpers
// ---------------------------------------------------------------------------

const POLL_MS = 2_000;
const MAX_WAIT_MS = 15 * 60 * 1_000;
const TIMER_CHECK_MS = 30_000;

// Shared across all sessions so multiple omp instances don't drift
const SHARED_STATE_FILE = join(homedir(), ".omp", "agent", "stretchly-sync.state");

function readSharedLastBreak(): number {
	try {
		if (!existsSync(SHARED_STATE_FILE)) return 0;
		const raw = JSON.parse(readFileSync(SHARED_STATE_FILE, "utf8"));
		return typeof raw.lastBreakAt === "number" ? raw.lastBreakAt : 0;
	} catch {
		return 0;
	}
}

function writeSharedLastBreak(ts: number): void {
	try {
		writeFileSync(SHARED_STATE_FILE, JSON.stringify({ lastBreakAt: ts }));
	} catch {}
}

async function isBreakWindowVisible(): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				[
					"Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr hWnd);' -Name WinAPI -Namespace StretchlySync;",
					'@(Get-Process -Name "stretchly" -EA 0 | Where-Object { $_.MainWindowHandle -ne 0 -and [StretchlySync.WinAPI]::IsWindowVisible($_.MainWindowHandle) }).Count',
				].join(" "),
			],
			{ timeout: 5_000, windowsHide: true },
		);
		return parseInt(stdout.trim(), 10) > 0;
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stretchlyCli(...args: string[]): Promise<void> {
	try {
		await execFileAsync("stretchly", args, {
			timeout: 10_000,
			windowsHide: true,
		});
	} catch {
		// Stretchly not running or CLI error — degrade gracefully
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function stretchlySync(pi: ExtensionAPI) {
	pi.setLabel("Stretchly Sync");

	const LOG_FILE = join(homedir(), ".omp", "agent", "stretchly-sync.log");

	function log(msg: string): void {
		const ts = new Date().toISOString();
		try {
			appendFileSync(LOG_FILE, `${ts} ${msg}\n`);
		} catch {}
	}

	const config = loadConfig(log);

	const debug = config.debug
		? log
		: (_msg: string) => {};

	debug(`--- loaded --- interval=${config.microbreakIntervalMs}ms, longBreakAfter=${config.longBreakAfter}`);

	// Seed from shared state so a new session respects breaks from other sessions
	let lastBreakAt = readSharedLastBreak() || Date.now();
	let microCount = 0;
	let activeBreak: Promise<void> | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;

	// Captured from session events so the background timer can update the status line
	let sessionUI: { setStatus(key: string, text: string): void } | null = null;

	function setStatus(key: string, text: string): void {
		try { sessionUI?.setStatus(key, text); } catch {}
	}

	/**
	 * Waits for a visible break window to close, showing elapsed time in the
	 * status line. Used for both reactive (Stretchly-triggered) and proactive
	 * (extension-triggered) breaks.
	 */
	async function waitForBreakEnd(label: string): Promise<void> {
		const start = Date.now();
		while (await isBreakWindowVisible()) {
			if (Date.now() - start > MAX_WAIT_MS) break;
			const secs = Math.round((Date.now() - start) / 1_000);
			setStatus("stretchly", `${label} — paused (${secs}s)`);
			await sleep(POLL_MS);
		}
		setStatus("stretchly", "");
	}

	/** Called after any break (reactive or proactive) to reset bookkeeping. */
	function onBreakFinished(type: "mini" | "long"): void {
		lastBreakAt = Date.now();
		writeSharedLastBreak(lastBreakAt);
		if (type === "long") {
			microCount = 0;
		} else {
			microCount++;
		}
		activeBreak = null;
		debug(`break finished (${type}), microCount=${microCount}`);
	}

	/**
	 * Core break handler. Covers two cases:
	 *
	 * 1. Reactive: Stretchly triggered a break on its own — we detect the
	 *    visible window and wait for it to close.
	 * 2. Proactive: Enough time has passed without a break — we trigger one
	 *    via the Stretchly CLI, then wait.
	 *
	 * Returns a promise that resolves when the break ends.
	 */
	async function handleBreak(): Promise<void> {
		// Reactive: Stretchly already showing a break?
		if (await isBreakWindowVisible()) {
			debug("reactive: break window detected");
			await waitForBreakEnd("Break");
			onBreakFinished("mini"); // can't distinguish type from window alone
			return;
		}

		// Proactive: has enough time passed?
		// Re-read shared state in case another session just finished a break
		const sharedTs = readSharedLastBreak();
		if (sharedTs > lastBreakAt) lastBreakAt = sharedTs;
		const elapsed = Date.now() - lastBreakAt;
		if (elapsed < config.microbreakIntervalMs) return;

		const type = microCount >= config.longBreakAfter ? "long" : "mini";
		const label = type === "mini" ? "Micro break" : "Long break";
		debug(`proactive: triggering ${type} at ${(elapsed / 60_000).toFixed(1)}min`);

		setStatus("stretchly", `${label} — triggering`);
		await stretchlyCli(type);
		await sleep(3_000);

		if (await isBreakWindowVisible()) {
			await waitForBreakEnd(label);
		} else {
			// Window didn't appear — Stretchly may not be running.
			// Wait a fallback duration so we don't re-trigger immediately.
			const fallback = type === "mini" ? 30_000 : 5 * 60_000;
			setStatus("stretchly", `${label} — paused (no window)`);
			await sleep(fallback);
			setStatus("stretchly", "");
		}

		onBreakFinished(type);
	}

	/** Entry point for both timer and tool_call. Deduplicates via activeBreak. */
	function triggerIfNeeded(source: string): void {
		if (activeBreak) return;
		activeBreak = handleBreak().catch((e: any) => {
			debug(`${source} error: ${e.message}`);
			activeBreak = null;
		});
	}

	// --- Session lifecycle ---
	// No pause/resume — Stretchly's own timer runs undisturbed.
	// If Stretchly triggers a break, we detect it reactively.
	// If it doesn't, we trigger proactively.

	pi.on("session_start", async (_event, ctx) => {
		debug("session_start");
		lastBreakAt = Date.now();
		microCount = 0;
		sessionUI = ctx.ui;

		timer = setInterval(() => triggerIfNeeded("timer"), TIMER_CHECK_MS);
	});

	pi.on("session_shutdown", async () => {
		debug("session_shutdown");
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	});

	// --- Tool call gate ---

	pi.on("tool_call", async (_event, ctx) => {
		sessionUI = ctx.ui;

		triggerIfNeeded("tool_call");

		if (activeBreak) {
			await activeBreak;
		}
	});

	// --- /break command ---

	pi.registerCommand("break", {
		description: "Trigger a Stretchly break now (default: mini, or /break long)",
		handler: async (args, ctx) => {
			sessionUI = ctx.ui;

			if (activeBreak) {
				ctx.ui.notify("A break is already active", "info");
				return;
			}

			const type = args.trim() === "long" ? "long" : "mini";
			ctx.ui.notify(`Triggering ${type} break`, "info");
			activeBreak = handleBreak();
			// Force proactive regardless of timer by calling CLI directly
			setStatus("stretchly", `${type === "mini" ? "Micro" : "Long"} break — triggering`);
			await stretchlyCli(type);
			await sleep(3_000);
			if (await isBreakWindowVisible()) {
				await waitForBreakEnd(type === "mini" ? "Micro break" : "Long break");
			}
			onBreakFinished(type);
		},
	});
}
