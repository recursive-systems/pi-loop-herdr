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
fs.appendFileSync(${JSON.stringify(dir)} + "/calls.log", JSON.stringify(a) + "\\n");
if (a[0] === "run") console.log(JSON.stringify({ address: "t7" }));
else if (a[0] === "ls") console.log(JSON.stringify({ terminals: [] }));
else console.log("{}");
`, { mode: 0o755 });
	const state = path.join(dir, "state", "herdr-core", "default");
	fs.mkdirSync(state, { recursive: true });
	fs.writeFileSync(path.join(dir, "sock"), "");
	fs.writeFileSync(path.join(state, "core.lock"), path.join(dir, "sock") + "\n");
	return { bin, calls: () => fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").map(l => JSON.parse(l)) };
}

function bus() {
	const on = new Map<string, ((d: any) => void)[]>();
	return { events: { on: (c: string, f: (d: any) => void) => { on.set(c, [...(on.get(c) ?? []), f]); }, emit: (c: string, d: any) => { for (const f of on.get(c) ?? []) f(d); } }, on: () => {} };
}

test("supplies a terminal for a terminal run: hc run with the run's argv, outliving the loop's session, labelled as a run", async t => {
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
	// Its labels follow the run (a thread's next fire, then its end); no watcher is started for it.
	pi.events.emit("loop:run", { v: 1, phase: "running", loop: "check", fire: 5, attemptId: "b", terminal: "t7" });
	pi.events.emit("loop:run", { v: 1, phase: "end", loop: "check", fire: 5, attemptId: "b", terminal: "t7", status: "done" });
	await new Promise(r => setTimeout(r, 500));
	const labels = hc.calls().filter(c => c[0] === "label");
	assert.deepEqual(labels[0], ["label", "t7", "loop-fire=5", "loop-status=running", "loop-ended="]);
	assert.equal(labels[1][2], "loop-status=done");
	assert.equal(hc.calls().filter(c => c[0] === "run").length, 1);
});
