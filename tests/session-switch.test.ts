import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Pi replaces both the extension instance and its event listener on a session switch.
test("the new session labels a watcher opened by the previous session", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-loop-herdr-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "hc"), "", { mode: 0o755 });
	const env = { PATH: dir, XDG_STATE_HOME: dir, HC_SOCKET: join(dir, "socket"), PI_LOOP_CHILD: "", PI_LOOP_WATCH: "" };
	const before = Object.entries(env).map(([key, value]) => {
		const entry = [key, process.env[key]] as const;
		process.env[key] = value;
		return entry;
	});
	t.after(() => {
		for (const [key, value] of before) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	const calls: string[][] = [];
	const exec = t.mock.method(childProcess, "execFile", (_bin, args, _options, callback) => {
		calls.push(args);
		callback(null, args[0] === "run" ? '{"address":"t1"}' : "{}");
	});
	syncBuiltinESMExports();
	t.after(() => { exec.mock.restore(); syncBuiltinESMExports(); });

	async function bind(version: string) {
		const { default: extension } = await import(`../index.ts?session=${version}`);
		let listener!: (event: object) => void;
		extension({ events: { on: (_name: string, fn: typeof listener) => { listener = fn; } }, on() {} });
		return listener;
	}
	const run = { v: 1, loop: "sample", fire: 1, attemptId: "sample-attempt", watch: { argv: ["pi"], env: {}, cwd: dir } };
	const start = await bind("previous");
	const waits: Promise<unknown>[] = [];
	const childEnv: Record<string, string> = {};
	start({ ...run, phase: "start", env: childEnv, waitFor: (p: Promise<unknown>) => waits.push(p) });
	await Promise.all(waits);
	assert.equal(childEnv.HC_TERMINAL_ID, "t1");

	const end = await bind("new");
	end({ ...run, phase: "end", status: "done" });
	end({ ...run, phase: "end", status: "done" }); // The consumed attempt cannot label a second time.
	const labels = calls.filter(([command]) => command === "label");
	assert.equal(labels.length, 1);
	assert.deepEqual(labels[0].slice(0, 3), ["label", "t1", "loop-status=done"]);
	assert.match(labels[0][3], /^loop-ended=\d+$/);
});
