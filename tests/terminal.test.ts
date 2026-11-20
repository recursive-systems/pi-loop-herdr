// pi-loop-herdr against a fake hc that keeps terminals in a JSON file (with labels), filters `ls --label` as hc does,
// applies `run`/`label`/`kill`/`rm`, and records every call. A real-core dry run is separate (see trial.md).
// Run: node --experimental-strip-types --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import loopHerdr from "../index.ts";

const SHARED = Symbol.for("pi-loop-herdr.state.v1");

/** A fake hc on terminals.json. `ON_GET` (a file): rows to swap in after the n-th `get` (a change between a sweep's look and its act). */
function fakeHc(dir: string) {
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, "hc"), `#!${process.execPath}
const fs = require("fs"), a = process.argv.slice(2), d = ${JSON.stringify(dir)};
if (a[0] === "label" && a.includes("loop-status=running")) { const end = Date.now() + 400; while (Date.now() < end) {} }
fs.appendFileSync(d + "/calls.log", JSON.stringify(a) + "\\n");
const f = d + "/terminals.json", ts = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
const save = () => fs.writeFileSync(f, JSON.stringify(ts));
const want = []; for (let i = 0; i < a.length; i++) if (a[i] === "--label") { const [k, v] = a[i + 1].split("="); want.push([k, v]); }
const t = ts.find(x => x.address === a[1]);
if (a[0] === "run") {
	const address = "t" + (100 + ts.length);
	ts.push({ address, state: "live", labels: Object.fromEntries(want), status: { app: a.includes("loop-kind=run") ? "pi" : "pi-loop", state: "working" } });
	save(); console.log(JSON.stringify({ address }));
} else if (a[0] === "ls") {
	console.log(JSON.stringify({ terminals: ts.filter(x => (a.includes("--all") || x.state === "live") && want.every(([k, v]) => (x.labels || {})[k] === v)).map(x => ({ address: x.address, state: x.state })) }));
} else if (a[0] === "get") {
	console.log(JSON.stringify(t ?? {}));
	const sw = d + "/swap.json";
	if (fs.existsSync(sw)) { const s = JSON.parse(fs.readFileSync(sw, "utf8")); if (s.after === a[1]) { fs.writeFileSync(f, JSON.stringify(s.rows)); fs.rmSync(sw); } }
} else if (a[0] === "label" && t) { for (const kv of a.slice(2)) { const [k, v] = kv.split("="); if (v) t.labels[k] = v; else delete t.labels[k]; } save(); console.log("{}"); }
else if (a[0] === "kill" && t) { t.state = "finished"; save(); console.log("{}"); }
else if (a[0] === "rm" && t) { ts.splice(ts.indexOf(t), 1); save(); console.log("{}"); }
else console.log("{}");
`, { mode: 0o755 });
	const state = path.join(dir, "state", "herdr-core", "default");
	fs.mkdirSync(state, { recursive: true });
	fs.writeFileSync(path.join(dir, "sock"), "");
	fs.writeFileSync(path.join(state, "core.lock"), path.join(dir, "sock") + "\n");
	return {
		bin,
		calls: (): string[][] => { try { return fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } },
		rows: (): any[] => JSON.parse(fs.readFileSync(path.join(dir, "terminals.json"), "utf8")),
		setRows: (rows: any[]) => fs.writeFileSync(path.join(dir, "terminals.json"), JSON.stringify(rows)),
		swapAfterGet: (address: string, rows: any[]) => fs.writeFileSync(path.join(dir, "swap.json"), JSON.stringify({ after: address, rows })),
	};
}

function bus() {
	const on = new Map<string, ((d: any) => void)[]>(), hooks = new Map<string, ((e: any, c: any) => void)[]>();
	return {
		events: { on: (c: string, f: (d: any) => void) => { on.set(c, [...(on.get(c) ?? []), f]); }, emit: (c: string, d: any) => { for (const f of on.get(c) ?? []) f(d); } },
		on: (e: string, f: (ev: any, c: any) => void) => { hooks.set(e, [...(hooks.get(e) ?? []), f]); },
		fire: (e: string, c: any = {}) => { for (const f of hooks.get(e) ?? []) f({}, c); },
	};
}

/** A fresh fake core and a project folder; env pointed at them; the extension's shared state cleared. */
function setup(t: any) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plh-"));
	const project = path.join(dir, "project");
	fs.mkdirSync(project);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const hc = fakeHc(dir);
	hc.setRows([]);
	const saved = { PATH: process.env.PATH, XDG_STATE_HOME: process.env.XDG_STATE_HOME, HC_TERMINAL_ID: process.env.HC_TERMINAL_ID, HC_SESSION: process.env.HC_SESSION };
	t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; delete (globalThis as any)[SHARED]; });
	Object.assign(process.env, { PATH: `${hc.bin}:${process.env.PATH}`, XDG_STATE_HOME: path.join(dir, "state"), HC_TERMINAL_ID: "t3" });
	delete process.env.HC_SESSION;
	delete (globalThis as any)[SHARED];
	return { dir, project, hc };
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const acts = (calls: string[][]) => calls.filter(c => ["kill", "rm", "label", "send"].includes(c[0]!)).map(c => c.join(" "));

/** Rows as t3's installed pi-loop-herdr (0.1.0 / c1e7d21) leaves them: no owner label, same loop ids possible. */
function t3Rows(old: number) {
	return [
		{ address: "t3w-done-old", state: "live", labels: { loop: "canary", "loop-by": "pi-loop-herdr", "loop-fire": "1", "loop-status": "done", "loop-ended": String(old) }, status: { app: "pi-loop", state: "done" }, status_ms: old },
		{ address: "t3w-unlabelled", state: "live", labels: { loop: "canary", "loop-by": "pi-loop-herdr", "loop-fire": "2" }, status: { app: "pi-loop", state: "done" }, status_ms: old },
		{ address: "t3w-working", state: "live", labels: { loop: "vm-services", "loop-by": "pi-loop-herdr", "loop-fire": "9" }, status: { app: "pi-loop", state: "working" }, status_ms: old },
		{ address: "t3w-finished", state: "finished", labels: { loop: "canary", "loop-by": "pi-loop-herdr", "loop-fire": "3" } },
		{ address: "t3-run-live", state: "live", labels: { loop: "canary", "loop-by": "pi-loop-herdr", "loop-kind": "run", "loop-fire": "4" }, status: { app: "pi", state: "done" } },
	];
}

test("it opens only terminals carrying its owner label, and supplies a terminal for a terminal run", async t => {
	const { project, hc } = setup(t);
	const pi = bus();
	loopHerdr(pi);
	pi.fire("session_start", { cwd: project });
	const owner = fs.readFileSync(path.join(project, ".pi/loop-herdr-owner"), "utf8").trim();
	assert.match(owner, /^[a-z0-9]{24}$/, "an owner token per project folder");
	let handle: Promise<any> | undefined, ready!: () => void;
	const inherit: string[] = [];
	pi.events.emit("loop:terminal", { v: 1, op: "open", loop: "canary", fire: 1, attemptId: "a", runner: "pi", name: "canary-1", title: "", description: "",
		project, cwd: project, argv: ["node", "loop-run.mjs", "start", "/x"], ready: new Promise<void>(r => { ready = r; }), inherit, provide: (h: Promise<any>) => { handle = h; } });
	assert.ok(handle && inherit.includes("HC_*"));
	ready();
	const h = await handle;
	const row = hc.rows().find(r => r.address === h.id);
	assert.equal(row.labels["loop-owner"], owner, "the run's terminal carries the owner label");
	assert.equal(row.labels["loop-kind"], "run");
	const run = hc.calls().find(c => c[0] === "run")!;
	assert.ok(run.includes("--outlive-parent"));
	assert.equal(run[run.indexOf("--parent") + 1], "t3");
	// Its own run terminal: labelled in order, the end label last.
	pi.events.emit("loop:run", { v: 1, phase: "running", loop: "canary", fire: 1, attemptId: "a", terminal: h.id });
	pi.events.emit("loop:run", { v: 1, phase: "end", loop: "canary", fire: 1, attemptId: "a", terminal: h.id, status: "done" });
	await sleep(2000);
	assert.equal(hc.rows().find(r => r.address === h.id).labels["loop-status"], "done");
});

test("t3's terminals (another session's: no owner label, same loop ids) are invisible: never labelled, killed or removed, even when they look ended", async t => {
	const { project, hc } = setup(t);
	const old = Date.now() - 9 * 60 * 60_000;
	hc.setRows(t3Rows(old));
	const pi = bus();
	loopHerdr(pi);
	pi.fire("session_start", { cwd: project });
	await sleep(1500);
	// An end event naming t3's terminals (the same loop id, any attempt) changes nothing of theirs.
	for (const a of ["t3w-done-old", "t3w-unlabelled", "t3-run-live"]) pi.events.emit("loop:run", { v: 1, phase: "end", loop: "canary", fire: 1, attemptId: "x", terminal: a, status: "done" });
	pi.events.emit("loop:run", { v: 1, phase: "end", loop: "canary", fire: 2, attemptId: "y", status: "done", watch: { argv: ["pi"], env: {}, cwd: project } });
	await sleep(2500);
	assert.deepEqual(acts(hc.calls()), [], "nothing done to any of t3's terminals");
	assert.deepEqual(hc.rows().map(r => r.address).sort(), t3Rows(old).map(r => r.address).sort(), "all still there");
	assert.ok(hc.calls().filter(c => c[0] === "ls").every(c => c.some(x => x.startsWith("loop-owner="))), "every listing it makes is scoped to its own owner");
});

test("its own old watchers go as in 0.1.0 (end-labelled, beyond the budget); a live one without an end label is never killed; a row that changed since it was judged is left alone", async t => {
	const { project, hc } = setup(t);
	const pi = bus();
	loopHerdr(pi);
	pi.fire("session_start", { cwd: project });
	const owner = fs.readFileSync(path.join(project, ".pi/loop-herdr-owner"), "utf8").trim();
	const old = Date.now() - 9 * 60 * 60_000;
	const mineRow = (address: string, extra: any) => ({ address, state: "live", labels: { loop: "canary", "loop-by": "pi-loop-herdr", "loop-owner": owner, ...extra.labels }, status: { app: "pi-loop", state: "done" }, status_ms: old, ...extra.row });
	hc.setRows([
		...t3Rows(old),
		mineRow("m-ended-old", { labels: { "loop-status": "done", "loop-ended": String(old) } }),
		mineRow("m-unlabelled-old", { labels: {} }),
		mineRow("m-finished", { row: { state: "finished" } }),
		mineRow("m-changes", { labels: { "loop-status": "done", "loop-ended": String(old - 1) } }),
		{ address: "m-run-live", state: "live", labels: { loop: "canary", "loop-owner": owner, "loop-kind": "run" }, status: { app: "pi", state: "working" } },
	]);
	// Between its look and its act, m-changes is taken over (its program becomes pi): it must be left alone.
	const now = hc.rows();
	hc.swapAfterGet("m-changes", now.map(r => r.address === "m-changes" ? { ...r, status: { app: "pi", state: "working" } } : r));
	pi.fire("session_start", { cwd: project });
	await sleep(3000);
	const done = acts(hc.calls());
	assert.ok(done.includes("kill m-ended-old") && done.includes("rm m-ended-old"), `its own ended old watcher goes: ${done}`);
	assert.ok(done.includes("rm m-finished"), "its own finished watcher goes");
	assert.ok(!done.some(x => x.includes("m-unlabelled-old")), "a live watcher without an end label stays, whatever its screen says");
	assert.ok(!done.some(x => x.includes("m-changes")), "re-checked before acting: changed since, left alone");
	assert.ok(!done.some(x => x.includes("m-run-live")), "a live run terminal is never touched");
	assert.ok(!done.some(x => x.includes("t3")), "nothing of t3's");
});

test("across a reload the new instance labels the old instance's watcher (it is still ours)", async t => {
	const { project, hc } = setup(t);
	const first = bus();
	loopHerdr(first);
	first.fire("session_start", { cwd: project });
	const env: Record<string, string> = {};
	let wait: Promise<unknown> | undefined;
	first.events.emit("loop:run", { v: 1, phase: "start", loop: "canary", fire: 9, attemptId: "z", env, waitFor: (p: Promise<unknown>) => { wait = p; }, watch: { argv: ["pi"], env: {}, cwd: project } });
	await wait;
	const w = env.HC_TERMINAL_ID!;
	assert.ok(w);
	const second = bus();
	loopHerdr(second);
	second.fire("session_start", { cwd: project });
	second.events.emit("loop:run", { v: 1, phase: "end", loop: "canary", fire: 9, attemptId: "z", status: "done", watch: { argv: ["pi"], env: {}, cwd: project } });
	await sleep(1500);
	assert.equal(hc.rows().find(r => r.address === w).labels["loop-status"], "done");
});

test("a second session in another project (its own owner token) and this one never touch each other's terminals", async t => {
	const { dir, project, hc } = setup(t);
	const other = path.join(dir, "other");
	fs.mkdirSync(other);
	// A's owner token, as A would have made it; A itself isn't running here (a separate process, not swept now).
	const a = bus(); loopHerdr(a); a.fire("session_start", { cwd: project });
	await sleep(1000);
	const ownerA = fs.readFileSync(path.join(project, ".pi/loop-herdr-owner"), "utf8").trim();
	delete (globalThis as any)[SHARED]; // B is another process: none of A's in-memory state
	const old = Date.now() - 9 * 60 * 60_000;
	hc.setRows([{ address: "a-ended", state: "live", labels: { loop: "canary", "loop-by": "pi-loop-herdr", "loop-owner": ownerA, "loop-status": "done", "loop-ended": String(old) }, status: { app: "pi-loop", state: "done" } }]);
	const before = hc.calls().length;
	const b = bus(); loopHerdr(b); b.fire("session_start", { cwd: other });
	const ownerB = fs.readFileSync(path.join(other, ".pi/loop-herdr-owner"), "utf8").trim();
	assert.notEqual(ownerA, ownerB);
	await sleep(1500);
	assert.deepEqual(acts(hc.calls().slice(before)), [], "B leaves A's terminal alone, though it looks ended and old");
	assert.ok(hc.calls().slice(before).filter(c => c[0] === "ls").every(c => c.includes(`loop-owner=${ownerB}`)), "B lists only its own");
});
