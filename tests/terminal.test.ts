// pi-loop-herdr as pi-loop's terminal provider (loop:terminal v1), against a fake hc that records its calls.
// Run: node --experimental-strip-types --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import loopHerdr from "../index.ts";

/** A fake hc: `run` answers with an address; every call appended to calls.log. */
function fakeHc(dir: string) {
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, "hc"), `#!${process.execPath}
const fs = require("fs"), a = process.argv.slice(2);
const d = ${JSON.stringify(dir)};
// A label asking for "running" is slow, as a busy core can be: an unsequenced later "done" would land first.
if (a[0] === "label" && a.includes("loop-status=running")) { const end = Date.now() + 400; while (Date.now() < end) {} }
fs.appendFileSync(d + "/calls.log", JSON.stringify(a) + "\\n");
const ts = fs.existsSync(d + "/terminals.json") ? JSON.parse(fs.readFileSync(d + "/terminals.json", "utf8")) : [];
if (a[0] === "run") console.log(JSON.stringify({ address: "t7" }));
else if (a[0] === "ls" && a.includes("loop-kind=run") && fs.existsSync(d + "/fail-run-ls")) { console.error("core busy"); process.exit(1); }
else if (a[0] === "ls") console.log(JSON.stringify({ terminals: ts.filter(t => a.includes("loop-kind=run") ? t.labels["loop-kind"] === "run" : true) }));
else if (a[0] === "get") console.log(JSON.stringify(ts.find(t => t.address === a[1]) ?? {}));
else console.log("{}");
`, { mode: 0o755 });
	const state = path.join(dir, "state", "herdr-core", "default");
	fs.mkdirSync(state, { recursive: true });
	fs.writeFileSync(path.join(dir, "sock"), "");
	fs.writeFileSync(path.join(state, "core.lock"), path.join(dir, "sock") + "\n");
	return { bin, calls: () => fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").map(l => JSON.parse(l)) };
}

function bus() {
	const on = new Map<string, ((d: any) => void)[]>(), hooks = new Map<string, (() => void)[]>();
	return { events: { on: (c: string, f: (d: any) => void) => { on.set(c, [...(on.get(c) ?? []), f]); }, emit: (c: string, d: any) => { for (const f of on.get(c) ?? []) f(d); } },
		on: (e: string, f: () => void) => { hooks.set(e, [...(hooks.get(e) ?? []), f]); }, fire: (e: string) => { for (const f of hooks.get(e) ?? []) f(); } };
}

test("supplies a terminal for a terminal run: hc run with the run's argv, outliving the loop's session, labelled as a run", async t => {
	delete (globalThis as any)[Symbol.for("pi-loop-herdr.state.v1")];
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plh-term-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const hc = fakeHc(dir);
	const saved = { PATH: process.env.PATH, XDG_STATE_HOME: process.env.XDG_STATE_HOME, HC_TERMINAL_ID: process.env.HC_TERMINAL_ID, HC_SESSION: process.env.HC_SESSION };
	t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
	Object.assign(process.env, { PATH: `${hc.bin}:${process.env.PATH}`, XDG_STATE_HOME: path.join(dir, "state"), HC_TERMINAL_ID: "t3" });
	delete process.env.HC_SESSION;
	const pi = bus();
	loopHerdr(pi);
	let here = false;
	pi.events.emit("loop:terminal", { v: 1, op: "probe", here: () => { here = true; } });
	assert.equal(here, true, "says it supplies terminals");
	let handle: Promise<any> | undefined;
	let ready!: () => void;
	const inherit: string[] = [];
	pi.events.emit("loop:terminal", { v: 1, op: "open", loop: "check", fire: 4, attemptId: "a", runner: "pi", name: "check-4", title: "loop check #4", description: "",
		project: dir, cwd: dir, argv: ["sh", "/x/run.sh"], ready: new Promise<void>(r => { ready = r; }), inherit, provide: (h: Promise<any>) => { handle = h; } });
	assert.ok(handle, "provided synchronously");
	assert.ok(inherit.includes("HC_*"), "its terminal identity is the terminal's, not the run's environment");
	await new Promise(r => setTimeout(r, 200));
	assert.equal(fs.existsSync(path.join(dir, "calls.log")), false, "nothing started before ready");
	ready();
	const h = await handle;
	assert.equal(h.id, "t7");
	assert.equal(h.attach, "hc attach t7");
	const run = hc.calls().find(c => c[0] === "run")!;
	assert.ok(run.includes("--outlive-parent"));
	assert.deepEqual(run.slice(run.indexOf("--") + 1), ["sh", "/x/run.sh"]);
	assert.equal(run[run.indexOf("--name") + 1], "loop-check-4");
	assert.equal(run[run.indexOf("--parent") + 1], "t3");
	for (const l of ["loop=check", "loop-fire=4", "loop-runner=pi", "loop-kind=run"]) assert.ok(run.includes(l), l);
	await h.send("hello");
	assert.deepEqual(hc.calls().at(-1), ["send", "t7", "hello"]);
	await h.close();
	assert.deepEqual(hc.calls().at(-1), ["kill", "t7"]);
	// Its labels follow the run, in order even when the first is slow; no watcher is started for it.
	pi.events.emit("loop:run", { v: 1, phase: "running", loop: "check", fire: 4, attemptId: "a", terminal: "t7" });
	pi.events.emit("loop:run", { v: 1, phase: "end", loop: "check", fire: 4, attemptId: "a", terminal: "t7", status: "done" });
	await new Promise(r => setTimeout(r, 2500));
	const labels = hc.calls().filter(c => c[0] === "label");
	assert.deepEqual(labels[0], ["label", "t7", "loop-status=running", "loop-ended="]);
	assert.equal(labels[1][2], "loop-status=done", "the final label is the last one applied");
	assert.equal(hc.calls().filter(c => c[0] === "run").length, 1);
	// A run's end sweeps run terminals too: only finished ones beyond the budget go, a live one never.
	const before = hc.calls().length;
	const t0 = Date.now() - 7 * 60 * 60_000;
	fs.writeFileSync(path.join(dir, "terminals.json"), JSON.stringify([
		{ address: "t7", state: "live", labels: { "loop-kind": "run", loop: "check" } },
		{ address: "t8", state: "finished", labels: { "loop-kind": "run", loop: "check", "loop-ended": String(t0) } },
		{ address: "t9", state: "finished", labels: { "loop-kind": "run", loop: "check", "loop-ended": String(Date.now()) } },
	]));
	pi.events.emit("loop:run", { v: 1, phase: "end", loop: "check", fire: 5, attemptId: "b", terminal: "t9", status: "done" });
	await new Promise(r => setTimeout(r, 2500));
	const removed = hc.calls().slice(before).filter(c => c[0] === "rm" || c[0] === "kill").map(c => c.join(" "));
	assert.ok(removed.includes("rm t8"), `the old finished run terminal went: ${removed}`);
	assert.ok(!removed.some(x => x.includes("t7")), "the live one is never touched");
	assert.ok(!removed.some(x => x.includes("t9")), "the newest finished one stays");
	assert.ok(!removed.some(x => x.startsWith("kill")), "finished terminals are removed, not killed");
	// When the listing of run terminals fails, each candidate is classified by its own labels: a run's terminal (live, with
	// an old end label) is never killed, and an old finished watcher still goes.
	const before2 = hc.calls().length;
	fs.writeFileSync(path.join(dir, "fail-run-ls"), "");
	fs.writeFileSync(path.join(dir, "terminals.json"), JSON.stringify([
		{ address: "t7", state: "live", labels: { "loop-kind": "run", loop: "check", "loop-ended": String(t0) }, status: { app: "pi-loop", state: "done" } },
		{ address: "w1", state: "finished", labels: { loop: "other" } },
	]));
	pi.events.emit("loop:run", { v: 1, phase: "end", loop: "check", fire: 6, attemptId: "c", terminal: "t7", status: "done" });
	await new Promise(r => setTimeout(r, 2500));
	const acts = hc.calls().slice(before2).filter(c => c[0] === "rm" || c[0] === "kill").map(c => c.join(" "));
	assert.ok(!acts.some(x => x.includes("t7")), `the run terminal is untouched: ${acts}`);
	assert.ok(acts.includes("rm w1"), `a finished watcher still goes: ${acts}`);
	fs.rmSync(path.join(dir, "fail-run-ls"));
});

test("a watcher whose run ended across a reload is labelled by the new instance; one that never got an end label is swept once its own status says done for long enough", async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plh-reload-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const hc = fakeHc(dir);
	const saved = { PATH: process.env.PATH, XDG_STATE_HOME: process.env.XDG_STATE_HOME, HC_TERMINAL_ID: process.env.HC_TERMINAL_ID, HC_SESSION: process.env.HC_SESSION };
	t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
	Object.assign(process.env, { PATH: `${hc.bin}:${process.env.PATH}`, XDG_STATE_HOME: path.join(dir, "state"), HC_TERMINAL_ID: "t3" });
	delete process.env.HC_SESSION;
	delete (globalThis as any)[Symbol.for("pi-loop-herdr.state.v1")];
	// The first instance opens a watcher for a run; then a reload builds a second instance, which sees the run's end.
	const first = bus();
	loopHerdr(first);
	const env: Record<string, string> = {};
	let wait: Promise<unknown> | undefined;
	first.events.emit("loop:run", { v: 1, phase: "start", loop: "check", fire: 9, attemptId: "z", env, waitFor: (p: Promise<unknown>) => { wait = p; },
		watch: { argv: ["pi"], env: {}, cwd: dir } });
	await wait;
	assert.equal(env.HC_TERMINAL_ID, "t7");
	const second = bus();
	loopHerdr(second);
	second.events.emit("loop:run", { v: 1, phase: "end", loop: "check", fire: 9, attemptId: "z", status: "done", watch: { argv: ["pi"], env: {}, cwd: dir } });
	await new Promise(r => setTimeout(r, 1500));
	assert.ok(hc.calls().some(c => c[0] === "label" && c[1] === "t7" && c.includes("loop-status=done")), "the new instance labelled the old watcher");
	// A watcher an older version left without an end label: its own status says done, past the 6h retention. Swept; a
	// recent one, or one still working, isn't (an unlabelled one used to be kept for ever).
	const old = Date.now() - 7 * 60 * 60_000;
	fs.writeFileSync(path.join(dir, "terminals.json"), JSON.stringify([
		{ address: "w-old", state: "live", labels: { loop: "a", "loop-by": "pi-loop-herdr" }, status: { app: "pi-loop", state: "done" }, status_ms: old },
		{ address: "w-new", state: "live", labels: { loop: "b", "loop-by": "pi-loop-herdr" }, status: { app: "pi-loop", state: "done" }, status_ms: Date.now() },
		{ address: "w-busy", state: "live", labels: { loop: "c", "loop-by": "pi-loop-herdr" }, status: { app: "pi-loop", state: "working" }, status_ms: old },
	]));
	const before = hc.calls().length;
	second.fire("session_start");
	await new Promise(r => setTimeout(r, 2500));
	const acts = hc.calls().slice(before).filter(c => c[0] === "rm" || c[0] === "kill").map(c => c.join(" "));
	assert.ok(acts.includes("kill w-old") && acts.includes("rm w-old"), `the unlabelled old watcher is swept: ${acts} / ${JSON.stringify(hc.calls().slice(before))}`);
	assert.ok(!acts.some(x => x.includes("w-new")), "a recent one stays");
	assert.ok(!acts.some(x => x.includes("w-busy")), "a working one stays");
	delete (globalThis as any)[Symbol.for("pi-loop-herdr.state.v1")];
});
