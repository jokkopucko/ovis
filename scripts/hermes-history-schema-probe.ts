/**
 * Which Hermes child sessions are conversations of their own, as the installed hermes-agent itself
 * decides (Earlier sessions lists only those, server/session-history.ts hermesSessions).
 *
 * It runs hermes-agent's own SessionDB (never the agent, a model or a provider) in a temporary
 * HERMES_HOME, makes each kind of child row the way Hermes's own code makes it (/branch, a gateway
 * reset, a compression rotation, a delegate run, a tool session, the pre-marker rows of older
 * releases), then asks Hermes's own `list_sessions_rich` which rows its session list shows and its
 * `resolve_resume_session_id` which session `hermes --resume <id>` opens. It records the Hermes
 * commit, the schema version and the source definitions behind those answers, and with `--fixture`
 * writes the store it probed as the SQL script server/session-history.test.ts installs.
 *
 *   bun scripts/hermes-history-schema-probe.ts [--hermes <hermes-agent dir>] [--python <python3>]
 *     [--out <evidence.json>] [--fixture <state.sql>]
 *
 * The repository keeps its answers in server/fixtures/hermes-history/ (`--out .../evidence.json
 * --fixture .../state.sql`).
 *
 * Everything in the store is made up; nothing is read from a real ~/.hermes.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const option = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const hermesDir = option("hermes") ?? process.env["HERMES_AGENT_DIR"] ?? join(homedir(), ".hermes", "hermes-agent");
/** the interpreter of the environment Hermes's installer made (`~/.hermes/installs/<id>/environments/<id>/venv`), newest first */
function hermesPython(): string {
  const given = option("python") ?? process.env["HERMES_PYTHON"];
  if (given) return given;
  const installs = join(dirname(hermesDir), "installs");
  const found = existsSync(installs)
    ? [...new Bun.Glob("*/environments/*/venv/bin/python3").scanSync({ cwd: installs, followSymlinks: true })]
      .map((path) => join(installs, path)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
    : undefined;
  return found ?? "python3";
}
const git = (...args: string[]) => Bun.spawnSync(["git", "-C", hermesDir, ...args], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();

function definition(file: string, start: RegExp): { file: string; line: number; text: string } {
  const lines = readFileSync(join(hermesDir, file), "utf8").split("\n");
  const at = lines.findIndex((line) => start.test(line));
  assert.ok(at >= 0, `${file}: no ${start}`);
  const body = lines[at]!.startsWith("def ")
    // a signature over several lines closes with `) -> ...:` at the left margin
    ? (line: string) => line.trim() === "" || /^\s/.test(line) || /^\)/.test(line)
    : (line: string) => line.trim() !== "";
  let end = at + 1;
  while (end < lines.length && body(lines[end]!)) end++;
  while (end > at + 1 && lines[end - 1]!.trim() === "") end--;
  return { file, line: at + 1, text: lines.slice(at, end).join("\n") };
}

const CWD = "/work/project";
const OTHER_CWD = "/elsewhere";
// The rows, oldest first. Each is made by the call Hermes's own code makes for that kind of row
// (cited per kind below); the probe then pins their times so the fixture is the same every run.
const PYTHON = String.raw`
import json, sqlite3, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
home, cwd, other = Path(sys.argv[2]), sys.argv[3], sys.argv[4]
from hermes_state import SessionDB
from hermes_state_common import SCHEMA_VERSION
db = SessionDB(home / "state.db")
made = []
def session(sid, kind, *, parent=None, model_config=None, source="cli", key=None, where=cwd, prompt=None, title=None):
    # a child is made without a cwd, as /branch and a gateway reset make it: Hermes copies its parent's
    db.create_session(session_id=sid, source=source, parent_session_id=parent, model_config=model_config,
                      session_key=key, cwd=None if parent else where)
    if prompt:
        db.append_message(sid, role="user", content=prompt)
    if title:
        db.set_session_title(sid, title)
    made.append({"id": sid, "kind": kind})

# hermes_cli/cli_commands_mixin.py /branch: the child (stable _branched_from marker) before the parent
# is ended "branched"
session("20261010_090000_fx0101", "root", prompt="Fixture hermes native root prompt", title="Fixture native root")
session("20261010_091000_fx0102", "branch", parent="20261010_090000_fx0101",
        model_config={"max_iterations": 90, "reasoning_config": None, "_branched_from": "20261010_090000_fx0101"},
        prompt="Fixture hermes native branch prompt", title="Fixture native root #2")
db.end_session("20261010_090000_fx0101", "branched")
# gateway/session_recovery.py _session_create_kwargs: a reset child carries _reset_from and the
# parent's routing key; the parent was ended "session_reset"
session("20261010_092000_fx0103", "root", source="telegram", key="agent:main:telegram:dm:fixture",
        prompt="Fixture hermes native gateway prompt", title="Fixture native gateway")
db.end_session("20261010_092000_fx0103", "session_reset")
session("20261010_093000_fx0104", "reset", parent="20261010_092000_fx0103", source="telegram",
        key="agent:main:telegram:dm:fixture", model_config={"_reset_from": "20261010_092000_fx0103"},
        prompt="Fixture hermes native reset prompt", title="Fixture native reset")
# pre-marker rows (hermes_state_common.py legacy heuristics): a branch whose parent ended "branched"
# before it started, and a reset child on the parent's exact key whose parent ended "idle"
session("20261010_094000_fx0105", "root", prompt="Fixture hermes legacy root prompt", title="Fixture legacy root")
db.end_session("20261010_094000_fx0105", "branched")
session("20261010_095000_fx0106", "legacy-branch", parent="20261010_094000_fx0105",
        prompt="Fixture hermes legacy branch prompt", title="Fixture legacy branch")
# ... branched again: Hermes's resume of the branch follows its unmarked child (fx0119, made last)
db.end_session("20261010_095000_fx0106", "branched")
session("20261010_100000_fx0107", "root", source="telegram", key="agent:main:telegram:dm:legacy",
        prompt="Fixture hermes legacy gateway prompt", title="Fixture legacy gateway")
db.end_session("20261010_100000_fx0107", "idle")
session("20261010_101000_fx0108", "legacy-reset", parent="20261010_100000_fx0107", source="telegram",
        key="agent:main:telegram:dm:legacy", prompt="Fixture hermes legacy reset prompt", title="Fixture legacy reset")
# hermes_state_compression.py publish_compression_child: a branch compressed; the continuation
# inherits the branch's model_config verbatim, so its _branched_from names the branch's parent
session("20261010_102000_fx0109", "root", prompt="Fixture hermes compressed root prompt", title="Fixture compressed root")
branched = {"max_iterations": 90, "reasoning_config": None, "_branched_from": "20261010_102000_fx0109"}
session("20261010_103000_fx0110", "branch", parent="20261010_102000_fx0109", model_config=branched,
        prompt="Fixture hermes compressed branch prompt", title="Fixture compressed branch")
db.end_session("20261010_102000_fx0109", "branched")
db.publish_compression_child(parent_session_id="20261010_103000_fx0110", child_session_id="20261010_104000_fx0111",
        source="cli", messages=[{"role": "user", "content": "Fixture hermes compression summary"}],
        model_config=branched, cwd=cwd, require_compression_lease=False)
made.append({"id": "20261010_104000_fx0111", "kind": "compression"})
# tools/delegate_tool.py: a subagent run carries _delegate_from; a tool session has source "tool"
session("20261010_105000_fx0112", "delegate", parent="20261010_090000_fx0101",
        model_config={"_delegate_from": "20261010_090000_fx0101"}, prompt="Fixture hermes delegate prompt")
session("20261010_106000_fx0113", "tool", parent="20261010_090000_fx0101", source="tool", prompt="Fixture hermes tool prompt")
# no Hermes writer makes these: a marker of false, of null, a model_config that is no JSON
session("20261010_107000_fx0114", "false-marker", parent="20261010_090000_fx0101",
        model_config={"_branched_from": False}, prompt="Fixture hermes false marker prompt")
session("20261010_108000_fx0115", "null-marker", parent="20261010_090000_fx0101",
        model_config={"_branched_from": None}, prompt="Fixture hermes null marker prompt")
session("20261010_109000_fx0116", "malformed", parent="20261010_090000_fx0101", prompt="Fixture hermes malformed prompt")
# another folder's branch
session("20261010_110000_fx0117", "root", where=other, prompt="Fixture hermes elsewhere prompt", title="Fixture elsewhere")
session("20261010_111000_fx0118", "branch", parent="20261010_110000_fx0117", where=other,
        model_config={"_branched_from": "20261010_110000_fx0117"}, prompt="Fixture hermes elsewhere branch prompt")
db.end_session("20261010_110000_fx0117", "branched")
session("20261010_112000_fx0119", "legacy-branch", parent="20261010_095000_fx0106",
        prompt="Fixture hermes legacy branch of a branch prompt", title="Fixture legacy branch again")
# resolve_resume_session_id walks the newest unmarked child at each step, through rows with no
# messages, to the deepest one with messages: a branch whose empty child has a child with messages
# resumes there; a branch whose newest unmarked child is empty resumes as itself, an older child
# with messages notwithstanding; a reset child (no end reason) resumes into its unmarked child
session("20261010_113000_fx0120", "root", prompt="Fixture hermes deep root prompt", title="Fixture deep root")
session("20261010_114000_fx0121", "branch", parent="20261010_113000_fx0120",
        model_config={"_branched_from": "20261010_113000_fx0120"}, prompt="Fixture hermes deep branch prompt", title="Fixture deep branch")
db.end_session("20261010_113000_fx0120", "branched")
session("20261010_115000_fx0122", "unmarked-child", parent="20261010_114000_fx0121")
session("20261010_120000_fx0123", "unmarked-child", parent="20261010_115000_fx0122", prompt="Fixture hermes deep grandchild prompt")
session("20261010_121000_fx0124", "root", prompt="Fixture hermes shallow root prompt", title="Fixture shallow root")
session("20261010_122000_fx0125", "branch", parent="20261010_121000_fx0124",
        model_config={"_branched_from": "20261010_121000_fx0124"}, prompt="Fixture hermes shallow branch prompt", title="Fixture shallow branch")
db.end_session("20261010_121000_fx0124", "branched")
session("20261010_123000_fx0126", "unmarked-child", parent="20261010_122000_fx0125", prompt="Fixture hermes older child prompt")
session("20261010_124000_fx0127", "unmarked-child", parent="20261010_122000_fx0125")
session("20261010_125000_fx0128", "root", source="telegram", key="agent:main:telegram:dm:open",
        prompt="Fixture hermes open gateway prompt", title="Fixture open gateway")
db.end_session("20261010_125000_fx0128", "session_reset")
session("20261010_130000_fx0129", "reset", parent="20261010_125000_fx0128", source="telegram",
        key="agent:main:telegram:dm:open", model_config={"_reset_from": "20261010_125000_fx0128"},
        prompt="Fixture hermes open reset prompt", title="Fixture open reset")
session("20261010_131000_fx0130", "unmarked-child", parent="20261010_130000_fx0129", source="telegram",
        key="agent:main:telegram:dm:open", prompt="Fixture hermes open reset child prompt")
# a child compressed later: resolve_resume_session_id first follows get_compression_tip, whose chain
# step takes an unmarked, non-reset child of a row ended "compression". A legacy branch's continuation
# carries no marker, so the branch resumes as its continuation; a reset's continuation inherits
# _reset_from, which the chain step leaves out, so the reset resumes as itself
session("20261010_132000_fx0131", "root", prompt="Fixture hermes compressed legacy root prompt", title="Fixture compressed legacy root")
db.end_session("20261010_132000_fx0131", "branched")
session("20261010_133000_fx0132", "legacy-branch", parent="20261010_132000_fx0131",
        prompt="Fixture hermes compressed legacy branch prompt", title="Fixture compressed legacy branch")
db.publish_compression_child(parent_session_id="20261010_133000_fx0132", child_session_id="20261010_134000_fx0133",
        source="cli", messages=[{"role": "user", "content": "Fixture hermes legacy compression summary"}],
        cwd=cwd, require_compression_lease=False)
made.append({"id": "20261010_134000_fx0133", "kind": "compression"})
session("20261010_135000_fx0134", "root", source="telegram", key="agent:main:telegram:dm:compressed",
        prompt="Fixture hermes compressed gateway prompt", title="Fixture compressed gateway")
db.end_session("20261010_135000_fx0134", "session_reset")
reset = {"_reset_from": "20261010_135000_fx0134"}
session("20261010_136000_fx0135", "reset", parent="20261010_135000_fx0134", source="telegram",
        key="agent:main:telegram:dm:compressed", model_config=reset,
        prompt="Fixture hermes compressed reset prompt", title="Fixture compressed reset")
db.publish_compression_child(parent_session_id="20261010_136000_fx0135", child_session_id="20261010_137000_fx0136",
        source="telegram", messages=[{"role": "user", "content": "Fixture hermes reset compression summary"}],
        model_config=reset, cwd=cwd, require_compression_lease=False)
made.append({"id": "20261010_137000_fx0136", "kind": "compression"})
db.close()

# pin the times: row n started at 2026-10-10 09:00 + n*10 min, active 5 min later, ended (where it
# ended) 6 min later; messages at their session's start
conn = sqlite3.connect(home / "state.db")
conn.execute("UPDATE sessions SET model_config = '{\"_branched_from\": ' WHERE id = '20261010_109000_fx0116'")
base = 1791622800
for n, row in enumerate(made):
    start = base + n * 600
    conn.execute("UPDATE sessions SET started_at = ?, last_activity_at = ?, ended_at = CASE WHEN ended_at IS NULL THEN NULL ELSE ? END WHERE id = ?",
                 (start, start + 300, start + 360, row["id"]))
    conn.execute("UPDATE messages SET timestamp = ? WHERE session_id = ?", (start + 1, row["id"]))
# /branch makes the marked child before it ends the parent: the parent ends a minute after the child starts
for row in made:
    if row["kind"] == "branch":
        conn.execute("UPDATE sessions SET ended_at = (SELECT started_at + 60 FROM sessions WHERE id = ?) WHERE id = (SELECT parent_session_id FROM sessions WHERE id = ?)",
                     (row["id"], row["id"]))
conn.commit()
conn.close()

db = SessionDB(home / "state.db", read_only=True)
listed = [r["id"] for r in db.list_sessions_rich(limit=1000, exclude_sources=["tool"])]
listed_in_cwd = [r["id"] for r in db.list_sessions_rich(limit=1000, exclude_sources=["tool"], cwd_prefix=cwd)]
by_activity = [r["id"] for r in db.list_sessions_rich(limit=1000, exclude_sources=["tool"], order_by_last_active=True)]
conn = sqlite3.connect(f"file:{home / 'state.db'}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
rows = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM sessions")}
for row in made:
    stored = rows[row["id"]]
    row.update({
        "parent": stored["parent_session_id"], "source": stored["source"], "cwd": stored["cwd"],
        "end_reason": stored["end_reason"], "model_config": stored["model_config"],
        "listed": row["id"] in listed, "listed_in_cwd": row["id"] in listed_in_cwd,
        "listed_by_activity": row["id"] in by_activity,
        "resume_opens": db.resolve_resume_session_id(row["id"]),
    })
schema = {r["name"]: r["sql"] for r in conn.execute(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'messages', 'schema_version')")}
version = conn.execute("SELECT version FROM schema_version").fetchone()[0]
columns = [r["name"] for r in conn.execute("SELECT name FROM pragma_table_info('sessions')")]
dump = {
    "sessions": [dict(r) for r in conn.execute("SELECT * FROM sessions ORDER BY started_at")],
    "messages": [dict(r) for r in conn.execute("SELECT session_id, role, content, timestamp FROM messages WHERE role = 'user' ORDER BY id")],
}
print(json.dumps({"schema_version": version, "code_schema_version": SCHEMA_VERSION, "schema": schema,
                  "sessions_columns": columns, "rows": made, "native_list": listed, "native_list_in_cwd": listed_in_cwd,
                  "native_list_by_activity": by_activity, "dump": dump}))
`;

const literal = (value: unknown, cwd: string): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (value === cwd) return ":cwd";
  return `'${String(value).replaceAll("'", "''")}'`;
};

const home = mkdtempSync(join(tmpdir(), "herdr-hermes-schema-probe-"));
try {
  const python = hermesPython();
  const run = Bun.spawnSync([python, "-I", "-c", PYTHON, hermesDir, home, CWD, OTHER_CWD], {
    // HERMES_DISABLE_LAZY_INSTALLS: a HERMES_HOME that does not own the checkout would otherwise
    // have Hermes's bootstrap build it an environment of its own and re-run there
    // (hermes_cli/venv_sync.py prepare_launch); the probe needs only the installed one
    stdout: "pipe", stderr: "pipe", env: { HERMES_HOME: home, HOME: home, PATH: process.env["PATH"] ?? "", HERMES_DISABLE_LAZY_INSTALLS: "1" },
  });
  assert.equal(run.exitCode, 0, run.stderr.toString());
  const probe = JSON.parse(run.stdout.toString()) as {
    schema_version: number; code_schema_version: number; schema: Record<string, string>; sessions_columns: string[];
    rows: Array<{ id: string; kind: string; cwd: string; listed: boolean; listed_in_cwd: boolean; resume_opens: string }>;
    native_list: string[]; native_list_in_cwd: string[]; native_list_by_activity: string[];
    dump: { sessions: Array<Record<string, unknown>>; messages: Array<Record<string, unknown>> };
  };
  // the decision rule: at least one branch or reset child in the folder that Hermes's own list shows
  // and that `hermes --resume <its id>` opens as itself
  const proven = probe.rows.filter((row) => ["branch", "reset", "legacy-branch", "legacy-reset"].includes(row.kind)
    && row.cwd === CWD && row.listed_in_cwd && row.resume_opens === row.id);
  const evidence = {
    hermes: {
      // the user's home left out: the evidence is committed
      dir: hermesDir.replace(homedir(), "~"),
      commit: git("rev-parse", "HEAD"),
      describe: git("describe", "--tags", "--long"),
      committed: git("log", "-1", "--format=%cI"),
      python: python.replace(homedir(), "~"),
    },
    schema_version: probe.schema_version,
    code_schema_version: probe.code_schema_version,
    sessions_columns: probe.sessions_columns,
    source: {
      schema_version: definition("hermes_state_common.py", /^SCHEMA_VERSION = /),
      json_marker: definition("hermes_state_common.py", /^def _sql_json_extract\(/),
      branch_child: definition("hermes_state_common.py", /^_BRANCH_CHILD_SQL = /),
      reset_end_reasons: definition("hermes_state_common.py", /^_RESET_END_REASONS = /),
      legacy_reset_child: definition("hermes_state_common.py", /^def _legacy_reset_child_sql\(/),
      non_continuation_child: definition("hermes_state_common.py", /^def _non_continuation_child_sql\(/),
      reset_child: definition("hermes_state_common.py", /^_RESET_CHILD_SQL = /),
      listable_child: definition("hermes_state_common.py", /^_LISTABLE_CHILD_SQL = /),
      list_filter: definition("hermes_state_sessions.py", /^def _session_filter_where\(/),
      sessions_list_command: definition("hermes_cli/sessions_cmd.py", /^def _default_exclude\(/),
      branch_command: definition("hermes_cli/cli_commands_mixin.py", /# Create the child BEFORE ending the parent/),
      reset_row: definition("gateway/session_recovery.py", /def _session_create_kwargs\(/),
      resume_follows_compression: definition("hermes_cli/cli_agent_setup_mixin.py", /^def _compression_descendant\(/),
    },
    rows: probe.rows,
    native_list: probe.native_list,
    native_list_in_cwd: probe.native_list_in_cwd,
    native_list_by_activity: probe.native_list_by_activity,
    decision: {
      rule: "adopt when at least one branch/reset child in the workspace cwd is in Hermes's own session list and `hermes --resume <id>` opens that id",
      proven: proven.map((row) => ({ id: row.id, kind: row.kind })),
      adopted: proven.length > 0,
    },
  };
  const out = option("out");
  if (out) writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  const fixture = option("fixture");
  if (fixture) {
    const lines = [
      `-- hermes-agent ${evidence.hermes.commit} (${evidence.hermes.describe}), schema_version ${probe.schema_version}:`,
      "-- written by scripts/hermes-history-schema-probe.ts from the store Hermes's own SessionDB made; made-up rows.",
      ...["schema_version", "sessions", "messages"].map((table) => `${probe.schema[table]!.replace(/\s+/g, " ")};`),
      `INSERT INTO schema_version (version) VALUES (${probe.schema_version});`,
      ...probe.dump.sessions.map((row) => {
        const set = Object.entries(row).filter(([, value]) => value !== null && value !== "" && value !== 0);
        return `INSERT INTO sessions (${set.map(([name]) => name).join(", ")}) VALUES (${set.map(([, value]) => literal(value, CWD)).join(", ")});`;
      }),
      ...probe.dump.messages.map((row) => `INSERT INTO messages (session_id, role, content, timestamp) VALUES (${[row["session_id"], row["role"], row["content"], row["timestamp"]].map((value) => literal(value, CWD)).join(", ")});`),
    ];
    writeFileSync(fixture, `${lines.join("\n")}\n`);
  }
  console.log(JSON.stringify({ commit: evidence.hermes.commit, schema_version: probe.schema_version, native_list_in_cwd: probe.native_list_in_cwd, decision: evidence.decision }, null, 2));
} finally {
  rmSync(home, { recursive: true, force: true });
}
