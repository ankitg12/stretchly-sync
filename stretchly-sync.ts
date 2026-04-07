import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, appendFileSync, existsSync } from "fs";
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

	// Read Stretchly's own config for defaults
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

	// Apply local overrides (optional file)
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

async function isBreakWindowVisible(): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				// Use Win32 IsWindowVisible for accurate detection.
				// MainWindowHandle alone stays non-zero after Electron hides a window.
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

	// Bootstrap logger: always logs during config load so issues are diagnosable,
	// then respects config.debug for runtime messages.
	function log(msg: string): void {
		const ts = new Date().toISOString();
		try {
			appendFileSync(LOG_FILE, `${ts} ${msg}\n`);
		} catch {}
	}

	const config = loadConfig(log);

	// After config is loaded, gate runtime logging on debug flag
	const debug = config.debug
		? log
		: (_msg: string) => {};

	debug(`--- loaded --- interval=${config.microbreakIntervalMs}ms, longBreakAfter=${config.longBreakAfter}`);

	let lastBreakAt = Date.now();
	let microCount = 0;
	let activeBreak: Promise<void> | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;

	// Captured from session events so the background timer can update the status line
	let sessionUI: { setStatus(key: string, text: string): void } | null = null;

	function setStatus(key: string, text: string): void {
		try { sessionUI?.setStatus(key, text); } catch {}
	}

	async function runBreak(type: "mini" | "long"): Promise<void> {
		const label = type === "mini" ? "Micro break" : "Long break";
		debug(`break: ${type} starting`);
		setStatus("stretchly", `${label} — triggering`);

		await stretchlyCli(type);
		await sleep(3_000);

		const windowAppeared = await isBreakWindowVisible();
		debug(`break: window appeared = ${windowAppeared}`);

		if (windowAppeared) {
			const start = Date.now();
			while (await isBreakWindowVisible()) {
				if (Date.now() - start > MAX_WAIT_MS) break;
				const secs = Math.round((Date.now() - start) / 1_000);
				setStatus("stretchly", `${label} — paused (${secs}s)`);
				await sleep(POLL_MS);
			}
		} else {
			// Stretchly didn't show a window — wait a reasonable fallback
			const fallback = type === "mini" ? 30_000 : 5 * 60_000;
			setStatus("stretchly", `${label} — paused (no window detected)`);
			await sleep(fallback);
		}

		lastBreakAt = Date.now();
		if (type === "long") {
			microCount = 0;
		} else {
			microCount++;
		}

		setStatus("stretchly", "");
		activeBreak = null;
		debug(`break: ${type} finished`);
	}

	/** Shared trigger: check if a break is due and start it */
	function triggerIfDue(source: string): void {
		if (activeBreak) return;

		const elapsed = Date.now() - lastBreakAt;
		if (elapsed < config.microbreakIntervalMs) return;

		debug(`${source}: triggering at ${(elapsed / 60_000).toFixed(1)}min`);
		const type = microCount >= config.longBreakAfter ? "long" : "mini";
		activeBreak = runBreak(type);
	}

	// --- Session lifecycle ---

	pi.on("session_start", async (_event, ctx) => {
		debug("session_start");
		lastBreakAt = Date.now();
		microCount = 0;
		sessionUI = ctx.ui;

		await stretchlyCli("pause", "-d", "indefinitely");

		// Background timer: fires breaks even when idle
		timer = setInterval(() => triggerIfDue("timer"), TIMER_CHECK_MS);
	});

	pi.on("session_shutdown", async () => {
		debug("session_shutdown");
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		await stretchlyCli("resume");
	});

	// --- Tool call gate ---

	pi.on("tool_call", async (_event, ctx) => {
		// Keep UI reference fresh
		sessionUI = ctx.ui;

		// Check if a break is due (covers gap between timer ticks)
		triggerIfDue("tool_call");

		// If a break is active (from timer or this call), block until it ends
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
			activeBreak = runBreak(type);
			await activeBreak;
		},
	});
}
