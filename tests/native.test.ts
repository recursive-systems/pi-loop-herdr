import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// A native run (pi-loop's `native` on a start event): its own program runs in the terminal, under the session's,
// and pi-loop gets a handle to follow it. Old ones are swept unless the owner has typed into them since.
test("a native run starts its program in a terminal, hands back its handle, and its terminal is swept only if unused", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-loop-herdr-native-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "hc"), "", { mode: 0o755 });
	const env = { PATH: dir, XDG_STATE_HOME: dir, HC_SOCKET: join(dir, "socket"), HC_TERMINAL_ID: "t1", PI_LOOP_CHILD: "", PI_LOOP_WATCH: "" };
	const before = Object.entries(env).map(([k, v]) => { const e = [k, process.env[k]] as const; process.env[k] = v; return e; });
	t.after(() => { for (const [k, v] of before) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
	const calls: string[][] = [];
	const old = Date.now() - 7 * 60 * 60_000;
	const terminals: Record<string, any> = {
		t9: { state: "live", turn: 1, status: { app: "claude-code", state: "done" }, labels: { loop: "x", "loop-native": "claude", "loop-turn": "1", "loop-ended": String(old) } },
		t10: { state: "live", turn: 3, status: { app: "claude-code", state: "idle" }, labels: { loop: "x", "loop-native": "claude", "loop-turn": "1", "loop-ended": String(old) } },
		t11: { state: "live", turn: 1, status: { app: "claude-code", state: "done" }, labels: { loop: "x", "loop-native": "claude", "loop-turn": "1", "loop-ended": String(old - 1000) } },
	};
	// A watcher of the same loop, recent: the native sessions don't count against the watchers' own limit.
	const ago = (m: number) => String(Date.now() - m * 60_000);
	terminals.t13 = { state: "live", turn: 1, status: { app: "claude-code", state: "done" }, labels: { loop: "z", "loop-native": "claude", "loop-turn": "1", "loop-ended": ago(1) } };
	terminals.t14 = { state: "live", turn: 1, status: { app: "claude-code", state: "done" }, labels: { loop: "z", "loop-native": "claude", "loop-turn": "1", "loop-ended": ago(2) } };
	terminals.t15 = { state: "live", turn: 0, status: { app: "pi-loop", state: "done" }, labels: { loop: "z", "loop-ended": ago(3) } };
	let t11Reads = 0;
	const exec = t.mock.method(childProcess, "execFile", (_bin: string, args: string[], _o: unknown, cb: (e: unknown, out: string) => void) => {
		calls.push(args);
		const [cmd, a1] = args;
		if (cmd === "run") return cb(null, '{"address":"t8"}');
		if (cmd === "get" && a1 === "t8") return cb(null, JSON.stringify({ state: "live", turn: 1, status: { app: "claude-code", state: "blocked", kind: "permission", msg: "trust this folder" } }));
		// t11: unused when the sweep lists it, typed into by the owner before the sweep gets to it.
		if (cmd === "get" && a1 === "t11" && ++t11Reads > 1) return cb(null, JSON.stringify({ ...terminals.t11, turn: 2, status: { app: "claude-code", state: "working" } }));
		if (cmd === "get" && terminals[a1]) return cb(null, JSON.stringify(terminals[a1]));
		if (cmd === "ls") return cb(null, JSON.stringify({ terminals: Object.keys(terminals).map(address => ({ address, state: "live" })) }));
		if (cmd === "read") return cb(null, "screen text");
		if (cmd === "send") return cb(null, '{"started":true}');
		cb(null, "{}");
	});
	syncBuiltinESMExports();
	t.after(() => { exec.mock.restore(); syncBuiltinESMExports(); });

	const { default: extension } = await import("../index.ts?native");
	let listener!: (event: any) => void;
	extension({ events: { on: (_n: string, fn: typeof listener) => { listener = fn; } }, on() {} });
	const argv = ["env", "-u", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR=/x", "claude", "--model", "m", "the prompt"];
	let handle: Promise<any> | undefined;
	const waits: Promise<unknown>[] = [];
	const run = { v: 1, loop: "x", fire: 2, attemptId: "a2", agent: "claude-dev1", agentKind: "claude", watch: { argv: ["pi"], env: {}, cwd: dir } };
	listener({ ...run, phase: "start", env: {}, native: { agent: "claude-dev1", kind: "claude", argv, cwd: dir, host: (h: Promise<any>) => { handle = h; } }, waitFor: (p: Promise<unknown>) => waits.push(p) });
	await Promise.all(waits);
	const h = await handle;
	const started = calls.find(c => c[0] === "run")!;
	assert.deepEqual(started.slice(started.indexOf("--") + 1), argv, "exactly the program pi-loop gave, not a watcher");
	assert.ok(started.includes("loop-native=claude") && started.includes("t1"), "labelled native, under the session's terminal");
	assert.equal(h.id, "t8");
	assert.deepEqual(await h.status(), { state: "blocked", kind: "permission", msg: "trust this folder", turn: 1, exited: false });
	assert.equal(await h.read(), "screen text");
	assert.equal(await h.send("hello"), true);
	await h.keys("down", "enter");
	assert.deepEqual(calls.find(c => c[0] === "keys"), ["keys", "t8", "down", "enter"]);

	listener({ ...run, phase: "end", status: "done" });
	await new Promise(r => setTimeout(r, 100));
	const label = calls.find(c => c[0] === "label" && c[1] === "t8")!;
	assert.ok(label.includes("loop-status=done") && label.includes("loop-turn=1"), JSON.stringify(label));
	const killed = calls.filter(c => c[0] === "kill").map(c => c[1]);
	assert.ok(killed.includes("t9"), "an old native session nobody used is swept");
	assert.ok(!killed.includes("t10"), "one the owner typed into since its run ended is theirs");
	assert.ok(!killed.includes("t11"), "one the owner started using while the sweep ran stays");
	assert.ok(!killed.includes("t15"), "a recent watcher is kept by the watchers' own limit, whatever native sessions its loop has");
	assert.ok(killed.includes("t14") && !killed.includes("t13"), "only the newest native session per loop is kept");
});
