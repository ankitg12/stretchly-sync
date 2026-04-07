import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { execFile, execFileSync } from "child_process";
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
	/** How early (ms) a tool call can trigger a break before the scheduled time */
	earlyWindowMs: number;
	/** Enable file-based debug logging to ~/.omp/agent/stretchly-sync.log */
	debug: boolean;
}

const DEFAULTS: BreakConfig = {
	microbreakIntervalMs: 10 * 60 * 1_000,
	longBreakAfter: 9,
	earlyWindowMs: 30_000,
};

/**
 * Loads break schedule config.
 *
 * Priority (highest wins):
 *   1. ~/.omp/agent/stretchly-sync.json  (local override)
 *   2. %APPDATA%/Stretchly/config.json   (Stretchly's own config)
 *   3. Built-in defaults (10 min interval, long break after 9 micros)
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
			if (typeof raw.earlyWindowMs === "number" && raw.earlyWindowMs >= 0) {
				config.earlyWindowMs = raw.earlyWindowMs;
			}
			log(`local override: interval=${config.microbreakIntervalMs}ms, longBreakAfter=${config.longBreakAfter}`);
		} catch (e: any) {
			log(`local override read error: ${e.message}`);
		}
	}

	return config;
}

// ---------------------------------------------------------------------------
// Wall-clock break schedule
// ---------------------------------------------------------------------------

/**
 * Computes the next break time aligned to wall-clock boundaries.
 *
 * With a 10-minute interval, breaks land at :00, :10, :20, :30, :40, :50
 * of every hour. Every session computes the same times independently —
 * no shared state or coordination needed.
 */
function nextBreakTime(intervalMs: number, now: number = Date.now()): number {
	return Math.ceil(now / intervalMs) * intervalMs;
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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

/** Synchronous resume — used in process exit handler where async is not allowed. */
function stretchlyResumeSync(): void {
	try {
		execFileSync("stretchly", ["resume"], { timeout: 5_000, windowsHide: true });
	} catch {}
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

	let nextBreak = nextBreakTime(config.microbreakIntervalMs);
	let microCount = 0;
	let activeBreak: Promise<void> | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	debug(`--- loaded --- interval=${config.microbreakIntervalMs}ms, next break at ${formatTime(nextBreak)}`);

	// Captured from session events so the background timer can update the status line
	let sessionUI: { setStatus(key: string, text: string): void } | null = null;

	function setStatus(key: string, text: string): void {
		try { sessionUI?.setStatus(key, text); } catch {}
	}

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

	/** Schedules a single setTimeout to fire exactly at the next wall-clock break. */
	function scheduleBreakTimer(): void {
		if (timer) clearTimeout(timer);
		const delay = Math.max(0, nextBreak - Date.now());
		debug(`timer scheduled: ${formatTime(nextBreak)} (${Math.round(delay / 1000)}s)`);
		timer = setTimeout(() => {
			triggerIfNeeded("timer");
		}, delay);
	}

	function advanceSchedule(): void {
		const type = microCount >= config.longBreakAfter ? "long" : "mini";
		if (type === "long") {
			microCount = 0;
		} else {
			microCount++;
		}
		// Always advance to a future boundary. Uses the later of (previous
		// boundary + 1ms) and now, so missed breaks during Stretchly downtime
		// are skipped rather than replayed back-to-back.
		nextBreak = nextBreakTime(config.microbreakIntervalMs, Math.max(nextBreak + 1, Date.now()));
		debug(`schedule advanced: next break at ${formatTime(nextBreak)}, microCount=${microCount}`);
		scheduleBreakTimer();
	}

	/**
	 * Core break handler.
	 *
	 * 1. Reactive: if Stretchly is already showing a break, wait for it.
	 * 2. Proactive: if wall-clock says it's break time, trigger one.
	 */
	async function handleBreak(): Promise<void> {
		// Fast path: not near break time, skip the expensive PowerShell check
		const timeUntilBreak = nextBreak - Date.now();
		if (timeUntilBreak > config.earlyWindowMs) return;

		// Reactive: Stretchly already showing a break?
		if (await isBreakWindowVisible()) {
			debug("reactive: break window detected");
			await waitForBreakEnd("Break");
			advanceSchedule();
			return;
		}

		// Proactive: within the early window?
		if (timeUntilBreak > 0) return;

		const type = microCount >= config.longBreakAfter ? "long" : "mini";
		const label = type === "mini" ? "Micro break" : "Long break";
		debug(`proactive: triggering ${type} at ${formatTime(Date.now())}`);

		setStatus("stretchly", `${label} — triggering`);
		await stretchlyCli(type);
		await sleep(3_000);

		if (await isBreakWindowVisible()) {
			await waitForBreakEnd(label);
		} else {
			const fallback = type === "mini" ? 30_000 : 5 * 60_000;
			setStatus("stretchly", `${label} — paused (no window)`);
			await sleep(fallback);
			setStatus("stretchly", "");
		}

		advanceSchedule();
	}

	/** Entry point for both timer and tool_call. Deduplicates via activeBreak. */
	function triggerIfNeeded(source: string): void {
		if (activeBreak) return;
		activeBreak = handleBreak()
			.catch((e: any) => debug(`${source} error: ${e.message}`))
			.finally(() => { activeBreak = null; });
	}

	// --- Session lifecycle ---

	pi.on("session_start", async (_event, ctx) => {
		debug("session_start");
		sessionUI = ctx.ui;
		nextBreak = nextBreakTime(config.microbreakIntervalMs);
		microCount = 0;
		debug(`next break at ${formatTime(nextBreak)}`);

		// Resume first to clean up stale pause from a crashed session,
		// then pause so we control the schedule.
		await stretchlyCli("resume");
		await stretchlyCli("pause", "-d", "indefinitely");

		// Safety net: resume Stretchly even if the process exits abnormally.
		// process.on('exit') fires on normal exit, Ctrl+C, SIGTERM — not SIGKILL.
		// The resume-on-startup above handles the SIGKILL case.
		process.on("exit", stretchlyResumeSync);

		scheduleBreakTimer();
	});

	pi.on("session_shutdown", async () => {
		debug("session_shutdown");
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		await stretchlyCli("resume");
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
			const label = type === "mini" ? "Micro break" : "Long break";
			ctx.ui.notify(`Triggering ${type} break`, "info");

			activeBreak = (async () => {
				setStatus("stretchly", `${label} — triggering`);
				await stretchlyCli(type);
				await sleep(3_000);
				if (await isBreakWindowVisible()) {
					await waitForBreakEnd(label);
				}
				advanceSchedule();
				activeBreak = null;
			})();
			await activeBreak;
		},
	});
}
