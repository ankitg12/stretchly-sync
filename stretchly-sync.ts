import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { readFileSync, appendFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface BreakConfig {
	/**
	 * "reactive" (default): Stretchly manages its own schedule. Extension
	 *   detects break windows and pauses tool execution during them.
	 *
	 * "proactive": Extension pauses Stretchly and takes over scheduling.
	 *   Triggers breaks at wall-clock-aligned intervals (e.g. :00, :10, :20).
	 *   More predictable but heavier — prone to issues if Stretchly crashes.
	 */
	mode: "reactive" | "proactive";
	/** Interval between micro breaks in ms (proactive only, reads Stretchly config by default) */
	microbreakIntervalMs: number;
	/** Number of micro breaks before a long break (proactive only) */
	longBreakAfter: number;
	/** How early (ms) a tool call can trigger a break before wall-clock time (proactive only) */
	earlyWindowMs: number;
	/** Enable file-based debug logging to ~/.omp/agent/stretchly-sync.log */
	debug: boolean;
}

const DEFAULTS: BreakConfig = {
	mode: "reactive",
	microbreakIntervalMs: 10 * 60 * 1_000,
	longBreakAfter: 9,
	earlyWindowMs: 30_000,
	debug: false,
};

/**
 * Loads config. Priority: stretchly-sync.json > Stretchly config > defaults.
 *
 * Example stretchly-sync.json:
 *   { "mode": "proactive", "microbreakIntervalMs": 600000, "debug": true }
 */
function loadConfig(log: (msg: string) => void): BreakConfig {
	const config = { ...DEFAULTS };

	// Read Stretchly's own interval/schedule for proactive mode defaults
	const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
	const stretchlyPath = join(appData, "Stretchly", "config.json");
	if (existsSync(stretchlyPath)) {
		try {
			const raw = JSON.parse(readFileSync(stretchlyPath, "utf8"));
			if (typeof raw.microbreakInterval === "number" && raw.microbreakInterval > 0)
				config.microbreakIntervalMs = raw.microbreakInterval;
			if (typeof raw.breakInterval === "number" && raw.breakInterval > 0)
				config.longBreakAfter = raw.breakInterval;
		} catch {}
	}

	const overridePath = join(homedir(), ".omp", "agent", "stretchly-sync.json");
	if (existsSync(overridePath)) {
		try {
			const raw = JSON.parse(readFileSync(overridePath, "utf8"));
			if (raw.mode === "reactive" || raw.mode === "proactive") config.mode = raw.mode;
			if (typeof raw.microbreakIntervalMs === "number" && raw.microbreakIntervalMs > 0)
				config.microbreakIntervalMs = raw.microbreakIntervalMs;
			if (typeof raw.longBreakAfter === "number" && raw.longBreakAfter > 0)
				config.longBreakAfter = raw.longBreakAfter;
			if (typeof raw.earlyWindowMs === "number" && raw.earlyWindowMs >= 0)
				config.earlyWindowMs = raw.earlyWindowMs;
			if (typeof raw.debug === "boolean") config.debug = raw.debug;
		} catch (e: any) {
			log(`config read error: ${e.message}`);
		}
	}

	log(`mode=${config.mode} interval=${config.microbreakIntervalMs}ms debug=${config.debug}`);
	return config;
}

// ---------------------------------------------------------------------------
// Stretchly helpers
// ---------------------------------------------------------------------------

const POLL_MS = 2_000;
const MAX_WAIT_MS = 15 * 60 * 1_000;

async function isBreakWindowVisible(): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync(
			"powershell.exe",
			[
				"-NoProfile", "-NonInteractive", "-Command",
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
		await execFileAsync("stretchly", args, { timeout: 10_000, windowsHide: true });
	} catch {}
}

function stretchlyResumeSync(): void {
	try {
		execFileSync("stretchly", ["resume"], { timeout: 5_000, windowsHide: true });
	} catch {}
}

function nextWallClockBreak(intervalMs: number, from: number = Date.now()): number {
	return Math.ceil(from / intervalMs) * intervalMs;
}

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function stretchlySync(pi: ExtensionAPI) {
	pi.setLabel("Stretchly Sync");

	const LOG_FILE = join(homedir(), ".omp", "agent", "stretchly-sync.log");
	function log(msg: string): void {
		const ts = new Date().toISOString();
		try { appendFileSync(LOG_FILE, `${ts} ${msg}\n`); } catch {}
	}

	const config = loadConfig(log);
	const debug = config.debug ? log : (_msg: string) => {};
	debug(`--- loaded --- mode=${config.mode}`);

	let activeBreak: Promise<void> | null = null;
	let sessionUI: { setStatus(key: string, text: string): void } | null = null;

	function setStatus(key: string, text: string): void {
		try { sessionUI?.setStatus(key, text); } catch {}
	}

	/** Waits for the visible break window to close. */
	async function waitForBreakEnd(label = "Break"): Promise<void> {
		const start = Date.now();
		while (await isBreakWindowVisible()) {
			if (Date.now() - start > MAX_WAIT_MS) break;
			const secs = Math.round((Date.now() - start) / 1_000);
			setStatus("stretchly", `${label} — paused (${secs}s)`);
			await sleep(POLL_MS);
		}
		setStatus("stretchly", "");
		activeBreak = null;
		debug("break ended");
	}

	// =========================================================================
	// REACTIVE MODE
	// Stretchly runs its own schedule. Extension detects windows and pauses.
	// =========================================================================

	function setupReactive(ctx: { ui: typeof sessionUI }) {
		sessionUI = ctx.ui;

		pi.on("tool_call", async (_event, c) => {
			sessionUI = c.ui;
			if (activeBreak) { await activeBreak; return; }
			if (await isBreakWindowVisible()) {
				debug("reactive: break detected");
				activeBreak = waitForBreakEnd();
				await activeBreak;
			}
		});
	}

	// =========================================================================
	// PROACTIVE MODE
	// Extension pauses Stretchly, triggers breaks at wall-clock boundaries.
	// =========================================================================

	function setupProactive(ctx: { ui: typeof sessionUI }) {
		sessionUI = ctx.ui;

		let nextBreak = nextWallClockBreak(config.microbreakIntervalMs);
		let microCount = 0;
		let timer: ReturnType<typeof setTimeout> | null = null;

		// Lock file: one session triggers, others skip
		const LOCK_FILE = join(homedir(), ".omp", "agent", "stretchly-sync.lock");
		function lockAcquire(): boolean {
			try {
				const ts = existsSync(LOCK_FILE)
					? parseInt(readFileSync(LOCK_FILE, "utf8").trim(), 10)
					: 0;
				if (Date.now() - ts < config.microbreakIntervalMs) return false;
				writeFileSync(LOCK_FILE, String(Date.now()));
				return true;
			} catch { return false; }
		}

		function advance(): void {
			const type = microCount >= config.longBreakAfter ? "long" : "mini";
			if (type === "long") microCount = 0; else microCount++;
			nextBreak = nextWallClockBreak(config.microbreakIntervalMs, Math.max(nextBreak + 1, Date.now()));
			debug(`proactive: next break at ${formatTime(nextBreak)}, microCount=${microCount}`);
			timer = setTimeout(onTimer, Math.max(0, nextBreak - Date.now()));
		}

		async function onTimer(): Promise<void> {
			if (activeBreak) return;
			if (await isBreakWindowVisible()) {
				debug("proactive: reactive window detected");
				activeBreak = waitForBreakEnd();
				await activeBreak;
				advance();
				return;
			}
			if (!lockAcquire()) {
				debug("proactive: skipped — lock held by another session");
				advance();
				return;
			}
			const type = microCount >= config.longBreakAfter ? "long" : "mini";
			const label = type === "mini" ? "Micro break" : "Long break";
			debug(`proactive: triggering ${type} at ${formatTime(Date.now())}`);
			setStatus("stretchly", `${label} — triggering`);
			await stretchlyCli("resume");
			await stretchlyCli(type);
			await sleep(3_000);
			await stretchlyCli("pause", "-d", "indefinitely");
			activeBreak = waitForBreakEnd(label);
			await activeBreak;
			advance();
		}

		pi.on("tool_call", async (_event, c) => {
			sessionUI = c.ui;
			if (activeBreak) { await activeBreak; return; }
			const timeUntil = nextBreak - Date.now();
			if (timeUntil > config.earlyWindowMs) return;
			if (await isBreakWindowVisible()) {
				activeBreak = waitForBreakEnd();
				await activeBreak;
				advance();
			} else if (timeUntil <= 0 && lockAcquire()) {
				timer && clearTimeout(timer);
				await onTimer();
			}
		});

		debug(`proactive: next break at ${formatTime(nextBreak)}`);
		timer = setTimeout(onTimer, Math.max(0, nextBreak - Date.now()));

		return () => { timer && clearTimeout(timer); };
	}

	// =========================================================================
	// Session lifecycle
	// =========================================================================

	let proactiveCleanup: (() => void) | null = null;

	pi.on("session_start", async (_event, ctx) => {
		debug("session_start");
		sessionUI = ctx.ui;

		if (config.mode === "proactive") {
			await stretchlyCli("resume"); // clean up stale pause
			await stretchlyCli("pause", "-d", "indefinitely");
			process.on("exit", stretchlyResumeSync);
			proactiveCleanup = setupProactive(ctx);
		} else {
			setupReactive(ctx);
		}
	});

	pi.on("session_shutdown", async () => {
		debug("session_shutdown");
		proactiveCleanup?.();
		if (config.mode === "proactive") {
			process.off("exit", stretchlyResumeSync);
			await stretchlyCli("resume");
		}
	});

	// =========================================================================
	// /break command
	// =========================================================================

	pi.registerCommand("break", {
		description: "Trigger a Stretchly break now (default: mini, or /break long)",
		handler: async (args, ctx) => {
			sessionUI = ctx.ui;
			if (activeBreak) { ctx.ui.notify("A break is already active", "info"); return; }

			const type = args.trim() === "long" ? "long" : "mini";
			ctx.ui.notify(`Triggering ${type} break`, "info");

			if (config.mode === "proactive") {
				await stretchlyCli("resume");
				await stretchlyCli(type);
				await sleep(3_000);
				await stretchlyCli("pause", "-d", "indefinitely");
			} else {
				await stretchlyCli(type);
				await sleep(3_000);
			}

			if (await isBreakWindowVisible()) {
				activeBreak = waitForBreakEnd(type === "mini" ? "Micro break" : "Long break");
				await activeBreak;
			}
		},
	});
}
