/**
 * pi-loop-herdr: every pi-loop run that wakes a model shows up in Herdr (`hc`) as a named terminal, under the
 * terminal the loop's session runs in. What the run starts with `hc run` sits under the run's terminal.
 *
 *   rpc runner (pi-loop's default): the terminal holds a watcher of the hidden run, to watch, steer and take over
 *   pi runner (or any terminal runner): the terminal IS the run, an ordinary agent session you type into; it
 *           answers pi-loop's `loop:terminal` requests (v1) with a real terminal, which outlives the loop's
 *           session so a restart picks the run up instead of losing it
 *
 * It only listens on pi.events. If hc is missing or fails, it does nothing: rpc loops run as before, and a
 * terminal runner's run fails, saying nothing supplied a terminal.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type ExtensionAPI = any;

/** Finished watchers kept per loop, and how long a finished one is kept at most. */
const KEEP_PER_LOOP = 2;
const KEEP_MS = 6 * 60 * 60_000;
const LABEL = "loop-by=pi-loop-herdr";
/** Labels a terminal that IS a run (not a watcher). */
const RUN_LABEL = "loop-kind=run";

/** The core's socket: its lock file names it (shells may look elsewhere by default). */
function socket(): string | undefined {
	const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
	const session = process.env.HC_SESSION || "default";
	try {
		const s = fs.readFileSync(path.join(state, "herdr-core", session, "core.lock"), "utf8").trim().split("\n")[0]?.trim();
		if (s && fs.existsSync(s)) return s;
	} catch { /* no core here */ }
	return process.env.HC_SOCKET || process.env.HC_TERMINAL_SOCKET || undefined;
}

function hcBinary(): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter).concat(path.join(os.homedir(), ".local", "bin"))) {
		if (!dir) continue;
		const f = path.join(dir, "hc");
		try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* not here */ }
	}
	return undefined;
}

function hc(sock: string, args: string[], ms = 10_000): Promise<any> {
	const bin = hcBinary();
	if (!bin) return Promise.reject(new Error("hc not found"));
	return new Promise((resolve, reject) => {
		execFile(bin, args, { env: { ...process.env, HC_SOCKET: sock }, timeout: ms }, (err, stdout) => {
			if (err) return reject(err);
			try { resolve(stdout.trim() ? JSON.parse(stdout) : {}); } catch { resolve({ text: stdout }); }
		});
	});
}

/** A valid hc name (1-32 of a-z 0-9 - _), with an optional suffix kept whole. */
function hcName(base: string, suffix = ""): string {
	const clean = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "loop";
	return clean.slice(0, 32 - suffix.length).replace(/-+$/, "") + suffix;
}

export default function loopHerdr(pi: ExtensionAPI) {
	// Only the session that runs loops emits loop:run; in a run's own Pi or a watcher this stays idle.
	if (process.env.PI_LOOP_CHILD === "1" || process.env.PI_LOOP_WATCH) return;
	/** Run (attemptId) -> its terminal. */
	const terminals = new Map<string, string>();
	/** `<loop>#<fire>` -> its terminal, so a run that carries on (after the owner steps out) keeps its terminal. */
	const byFire = new Map<string, string>();
	let sweeping: Promise<void> | undefined;

	async function start(e: any, sock: string): Promise<void> {
		const give = (address: string) => {
			terminals.set(e.attemptId, address);
			byFire.set(`${e.loop}#${e.fire}`, address);
			if (byFire.size > 200) byFire.delete(byFire.keys().next().value!);
			// What the run starts with hc run goes under the run's terminal.
			e.env.HC_TERMINAL_ID = address;
			e.env.HC_SOCKET = sock;
			e.env.HC_TERMINAL_SOCKET = sock;
		};
		const known = byFire.get(`${e.loop}#${e.fire}`);
		if (known) {
			try {
				const g = await hc(sock, ["get", known, "--json"]);
				if (g?.state === "live") { await hc(sock, ["label", known, "loop-status=running", "loop-ended="]).catch(() => undefined); give(known); return; }
			} catch { /* gone: a new one */ }
		}
		const loopName = `loop-${e.loop}`;
		const fire = `-${e.fire}`;
		const parent = process.env.HC_TERMINAL_ID;
		const envArgs = Object.entries(e.watch.env as Record<string, string>).map(([k, v]) => `${k}=${v}`);
		for (let i = 0; i < 4; i++) {
			const name = hcName(loopName, i ? `${fire}-${i + 1}` : fire);
			try {
				const r = await hc(sock, ["run", "--bg", "--json", "--name", name, "--cwd", e.watch.cwd, "--no-notify",
					"--label", `loop=${e.loop}`, "--label", `loop-fire=${e.fire}`, "--label", LABEL,
					...(parent ? ["--parent", parent] : ["--no-parent"]),
					"--", "env", ...envArgs, ...e.watch.argv]);
				if (r?.address) { give(r.address); return; }
			} catch (err: any) {
				// A name taken by a live terminal: try the next; anything else: give up quietly.
				if (!/name|taken|exists|unique/i.test(String(err?.message ?? "") + String(err?.stderr ?? ""))) return;
			}
		}
	}

	/** Old finished watchers go: finished terminals at once, live ones whose run ended long ago or beyond the newest few per loop. */
	async function sweep(sock: string): Promise<void> {
		let list: any;
		try { list = await hc(sock, ["ls", "--all", "--json", "--label", LABEL]); } catch { return; }
		const now = Date.now();
		const ended: { address: string; loop: string; at: number; finished?: boolean }[] = [];
		// A run's own terminals (loop-kind=run): pi-loop ends each run's agent before it records it, so only finished
		// ones are swept here, kept like watchers (their last screen) within the same budget; a live one is never touched.
		let runs: any;
		try { runs = await hc(sock, ["ls", "--all", "--json", "--label", RUN_LABEL]); } catch { runs = undefined; }
		const runAddresses = new Set<string>((runs?.terminals ?? []).map((t: any) => t.address));
		for (const t of runs?.terminals ?? []) {
			if (t.state !== "finished") continue;
			let g: any;
			try { g = await hc(sock, ["get", t.address, "--json"]); } catch { continue; }
			const at = Number(g?.labels?.["loop-ended"]) || Number(g?.finished_ms) || now;
			ended.push({ address: t.address, loop: `run:${g?.labels?.loop ?? ""}`, at, finished: true });
		}
		for (const t of list?.terminals ?? []) {
			if (runAddresses.has(t.address)) continue;
			// As 0.1.0: a finished watcher goes at once, before anything is asked about it.
			if (t.state === "finished") { try { await hc(sock, ["rm", t.address]); } catch { /* gone */ } continue; }
			let g: any;
			try { g = await hc(sock, ["get", t.address, "--json"]); } catch { continue; }
			// Never one the owner works in: a taken-over run's own Pi reports as pi, not pi-loop.
			if (g?.status && g.status.app !== "pi-loop") continue;
			const at = Number(g?.labels?.["loop-ended"]);
			if (Number.isFinite(at) && at > 0) ended.push({ address: t.address, loop: g.labels.loop ?? "", at });
		}
		const byLoop = new Map<string, typeof ended>();
		for (const x of ended) byLoop.set(x.loop, [...(byLoop.get(x.loop) ?? []), x]);
		for (const xs of byLoop.values()) {
			xs.sort((a, b) => b.at - a.at);
			for (const [i, x] of xs.entries()) {
				if (i < KEEP_PER_LOOP && now - x.at < KEEP_MS) continue;
				try { if (!x.finished) await hc(sock, ["kill", x.address]); await hc(sock, ["rm", x.address]); } catch { /* gone */ }
			}
		}
	}

	/** A terminal for a run that is itself an agent session. Its argv carries no secrets (pi-loop hands those over itself). */
	async function open(r: any, sock: string): Promise<any> {
		await r.ready;
		const parent = process.env.HC_TERMINAL_ID;
		for (let i = 0; i < 4; i++) {
			const name = hcName(`loop-${r.loop}`, i ? `-${r.fire}-${i + 1}` : `-${r.fire}`);
			try {
				// --outlive-parent: the run is an ordinary session; restarting the loop's session must not end it.
				const t = await hc(sock, ["run", "--bg", "--json", "--name", name, "--cwd", r.cwd, "--no-notify", "--outlive-parent",
					"--label", `loop=${r.loop}`, "--label", `loop-fire=${r.fire}`, "--label", `loop-runner=${r.runner}`, "--label", LABEL, "--label", RUN_LABEL,
					...(parent ? ["--parent", parent] : ["--no-parent"]), "--", ...r.argv], 20_000);
				if (!t?.address) return undefined;
				const address: string = t.address;
				return {
					id: address, attach: `hc attach ${address}`,
					close: async () => { await hc(sock, ["kill", address]).catch(() => undefined); },
					send: async (text: string) => { try { await hc(sock, ["send", address, text]); return undefined; } catch (err: any) { return String(err?.stderr || err?.message || err).slice(0, 200); } },
				};
			} catch (err: any) {
				if (!/name|taken|exists|unique/i.test(String(err?.message ?? "") + String(err?.stderr ?? ""))) return undefined;
			}
		}
		return undefined;
	}

	pi.events.on("loop:terminal", (r: any) => {
		if (r?.v !== 1) return;
		const sock = socket();
		if (!sock || !hcBinary()) return;
		if (r.op === "probe" && typeof r.here === "function") { r.here(); return; }
		if (r.op !== "open" || typeof r.provide !== "function" || !Array.isArray(r.argv)) return;
		// The terminal sets these for its own program; the run's environment must not override them.
		if (Array.isArray(r.inherit)) r.inherit.push("HC_*", "HERDR_*");
		r.provide(open(r, sock).catch(() => undefined));
	});

	/** Labels for one terminal, applied in the order they were asked for (separate hc processes would race). */
	const labelling = new Map<string, Promise<unknown>>();
	function label(sock: string, address: string, labels: string[]): Promise<unknown> {
		const next = (labelling.get(address) ?? Promise.resolve()).then(() => hc(sock, ["label", address, ...labels])).catch(() => undefined);
		labelling.set(address, next);
		void next.then(() => { if (labelling.get(address) === next) labelling.delete(address); });
		return next;
	}
	const sweepSoon = (sock: string) => { if (!sweeping) sweeping = sweep(sock).finally(() => { sweeping = undefined; }); };

	pi.events.on("loop:run", (e: any) => {
		if (e?.v !== 1) return;
		// A run in its own terminal: labelled with how it is going and how it ended; finished ones are swept.
		if (!e.watch?.argv?.length) {
			const sock = socket();
			if (!e.terminal || !sock || !hcBinary()) return;
			if (e.phase === "running") void label(sock, e.terminal, ["loop-status=running", "loop-ended="]);
			if (e.phase === "end") void label(sock, e.terminal, [`loop-status=${e.status}`, `loop-ended=${Date.now()}`]).then(() => sweepSoon(sock));
			return;
		}
		const sock = socket();
		if (!sock || !hcBinary()) return;
		if (e.phase === "start" && typeof e.waitFor === "function" && e.env) {
			// Before the run's Pi starts, so it gets its terminal's identity (pi-loop waits a few seconds at most).
			e.waitFor(start(e, sock).catch(() => undefined));
			return;
		}
		if (e.phase === "end") {
			const t = terminals.get(e.attemptId);
			terminals.delete(e.attemptId);
			if (!t) return;
			// It stays, visibly done (or showing that the owner took the run over), until swept.
			const labels = [`loop-status=${e.status}`, `loop-ended=${Date.now()}`];
			void label(sock, t, labels).then(() => sweepSoon(sock));
		}
	});

	pi.on("session_start", () => {
		const sock = socket();
		if (sock && hcBinary() && !sweeping) sweeping = sweep(sock).finally(() => { sweeping = undefined; });
	});
}
