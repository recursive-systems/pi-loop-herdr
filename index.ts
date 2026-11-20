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
 *
 * It owns exactly what it opened: every terminal carries this session's owner label (loop-owner=<token>, per project
 * folder), and it labels, kills and removes only terminals with that label, re-checked just before acting.
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

/**
 * Who opened a terminal: this session's owner token, one per project folder and kept for that folder (so a session
 * that restarts in it is the same owner). Every terminal this extension opens carries `loop-owner=<token>`, and it only
 * ever labels, kills or removes terminals that carry its own token, re-checked just before acting. Terminals another
 * session opened, including older versions' (which carry no owner label), are never touched.
 */
function ownerToken(project: string): string {
	const dir = path.join(project, ".pi");
	const file = path.join(dir, "loop-herdr-owner");
	try { const t = fs.readFileSync(file, "utf8").trim(); if (/^[a-z0-9]{16,64}$/.test(t)) return t; } catch { /* first time */ }
	const t = Array.from({ length: 24 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
	try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, t + "\n", { mode: 0o600 }); } catch { /* not writable: this process only */ }
	return t;
}

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
	// Process-wide (a /reload rebuilds this extension while runs go on): which watcher belongs to which run, the label
	// queue, and the sweep in progress. A run started before a reload gets its end label from the new instance.
	const g: any = ((globalThis as any)[Symbol.for("pi-loop-herdr.state.v1")] ??= { terminals: new Map(), byFire: new Map(), labelling: new Map() });
	/** Run (attemptId) -> its terminal. */
	const terminals: Map<string, string> = g.terminals;
	/** `<loop>#<fire>` -> its terminal, so a run that carries on (after the owner steps out) keeps its terminal. */
	const byFire: Map<string, string> = g.byFire;
	let sweeping: Promise<void> | undefined;
	/** This session's owner label (see ownerToken), set once the project is known. */
	let owner: string | undefined = g.owner;
	const OWNER = () => `loop-owner=${owner}`;
	/** A terminal's facts, re-read now; it is ours only if it carries this owner's label. */
	async function mine(sock: string, address: string): Promise<any | undefined> {
		if (!owner) return undefined;
		let t: any;
		try { t = await hc(sock, ["get", address, "--json"]); } catch { return undefined; }
		return t?.labels?.["loop-owner"] === owner ? t : undefined;
	}

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
			const t = await mine(sock, known);
			if (t?.state === "live") { await label(sock, known, ["loop-status=running", "loop-ended="]); give(known); return; }
		}
		const loopName = `loop-${e.loop}`;
		const fire = `-${e.fire}`;
		const parent = process.env.HC_TERMINAL_ID;
		const envArgs = Object.entries(e.watch.env as Record<string, string>).map(([k, v]) => `${k}=${v}`);
		for (let i = 0; i < 4; i++) {
			const name = hcName(loopName, i ? `${fire}-${i + 1}` : fire);
			try {
				const r = await hc(sock, ["run", "--bg", "--json", "--name", name, "--cwd", e.watch.cwd, "--no-notify",
					"--label", `loop=${e.loop}`, "--label", `loop-fire=${e.fire}`, "--label", LABEL, ...(owner ? ["--label", OWNER()] : []),
					...(parent ? ["--parent", parent] : ["--no-parent"]),
					"--", "env", ...envArgs, ...e.watch.argv]);
				if (r?.address) { give(r.address); return; }
			} catch (err: any) {
				// A name taken by a live terminal: try the next; anything else: give up quietly.
				if (!/name|taken|exists|unique/i.test(String(err?.message ?? "") + String(err?.stderr ?? ""))) return;
			}
		}
	}

	/**
	 * This owner's old terminals go, and nothing else: only terminals labelled with this session's owner token are
	 * listed, and each is re-checked (still ours, still in the state it was judged in) just before it is touched.
	 *   a finished watcher            removed at once (as 0.1.0)
	 *   a live watcher with an end label (pi-loop says its run ended)
	 *                                 killed and removed beyond the newest two per loop, or after 6 hours (as 0.1.0)
	 *   a finished run terminal       removed within the same budget; a live run terminal is never touched
	 * A live watcher without an end label is never killed, whatever its screen says. Terminals of other sessions (another
	 * owner token, or none: an older version's) are invisible here.
	 */
	async function sweep(sock: string): Promise<void> {
		if (!owner) return;
		let list: any;
		try { list = await hc(sock, ["ls", "--all", "--json", "--label", OWNER()]); } catch { return; }
		const now = Date.now();
		const finishedAt = (x: any) => Number(x?.finished_ms ?? x?.times?.finished_ms) || 0;
		const ended: { address: string; loop: string; at: number; run: boolean; state: string }[] = [];
		for (const t of list?.terminals ?? []) {
			const info = await mine(sock, t.address);
			if (!info) continue;
			const isRun = info.labels?.["loop-kind"] === "run";
			if (isRun) {
				if (info.state !== "finished") continue;
				ended.push({ address: t.address, loop: `run:${info.labels?.loop ?? ""}`, at: Number(info.labels?.["loop-ended"]) || finishedAt(info) || now, run: true, state: "finished" });
				continue;
			}
			if (info.state === "finished") { if ((await mine(sock, t.address))?.state === "finished") { try { await hc(sock, ["rm", t.address]); } catch { /* gone */ } } continue; }
			// A watcher someone went into (its program is no longer the watcher): never touched.
			if (info.status && info.status.app !== "pi-loop") continue;
			const at = Number(info.labels?.["loop-ended"]);
			if (Number.isFinite(at) && at > 0) ended.push({ address: t.address, loop: info.labels?.loop ?? "", at, run: false, state: "live" });
		}
		const byLoop = new Map<string, typeof ended>();
		for (const x of ended) byLoop.set(x.loop, [...(byLoop.get(x.loop) ?? []), x]);
		for (const xs of byLoop.values()) {
			xs.sort((a, b) => b.at - a.at);
			for (const [i, x] of xs.entries()) {
				if (i < KEEP_PER_LOOP && now - x.at < KEEP_MS) continue;
				// Re-checked just before acting: still ours, still what it was judged to be.
				const now2 = await mine(sock, x.address);
				if (!now2 || now2.state !== x.state || (x.run ? now2.labels?.["loop-kind"] !== "run" : (now2.labels?.["loop-kind"] === "run" || Number(now2.labels?.["loop-ended"]) !== x.at || (now2.status && now2.status.app !== "pi-loop")))) continue;
				try { if (x.state === "live") await hc(sock, ["kill", x.address]); await hc(sock, ["rm", x.address]); } catch { /* gone */ }
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
					"--label", `loop=${r.loop}`, "--label", `loop-fire=${r.fire}`, "--label", `loop-runner=${r.runner}`, "--label", LABEL, "--label", RUN_LABEL, "--label", OWNER(),
					...(parent ? ["--parent", parent] : ["--no-parent"]), "--", ...r.argv], 20_000);
				if (!t?.address) return undefined;
				const address: string = t.address;
				return {
					id: address, attach: `hc attach ${address}`,
					close: async () => { if (await mine(sock, address)) await hc(sock, ["kill", address]).catch(() => undefined); },
					send: async (text: string) => { if (!(await mine(sock, address))) return "its terminal isn't this session's any more"; try { await hc(sock, ["send", address, text]); return undefined; } catch (err: any) { return String(err?.stderr || err?.message || err).slice(0, 200); } },
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
		if (!owner) return; // no owner yet (before session_start): nothing is opened that couldn't be scoped
		// The terminal sets these for its own program; the run's environment must not override them.
		if (Array.isArray(r.inherit)) r.inherit.push("HC_*", "HERDR_*");
		r.provide(open(r, sock).catch(() => undefined));
	});

	/** Labels for one terminal, applied in the order they were asked for (separate hc processes would race). */
	const labelling: Map<string, Promise<unknown>> = g.labelling;
	function label(sock: string, address: string, labels: string[]): Promise<unknown> {
		const next = (labelling.get(address) ?? Promise.resolve()).then(async () => { if (await mine(sock, address)) await hc(sock, ["label", address, ...labels]); }).catch(() => undefined);
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
		if (!owner) return; // nothing is opened or touched before this session's owner is known
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

	pi.on("session_start", (_e: any, c: any) => {
		if (!owner && c?.cwd) { owner = ownerToken(c.cwd); g.owner = owner; }
		const sock = socket();
		if (sock && hcBinary() && !sweeping) sweeping = sweep(sock).finally(() => { sweeping = undefined; });
	});
}
