#!/usr/bin/env python3
"""The Collective /goal — Codex-style persistent goals for Claude Code.

Fork of jthack/claude-goal, heavily customized for The Collective's
multi-agent architecture. Adds:
- Agent-aware goals (which agent owns this goal)
- Multi-agent goal chains (master -> sub-goals)
- Priority levels (critical/high/normal/low)
- Humanization enforcement in completion audit
- Hive Mind integration for cross-agent visibility
- Goal history and analytics
- Windows compatibility
- Cross-session persistence improvements
- RecursiveMAS 6-layer integration hooks (L1-L6)

Dependency-free: runs with stdlib Python 3.9+.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import sqlite3
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# sqlite3.Row safe accessor (Row lacks .get())
# ---------------------------------------------------------------------------

def _row_get(row: sqlite3.Row | dict, key: str, default: Any = None) -> Any:
    """Safe attribute access for sqlite3.Row (no .get()) and dicts."""
    if isinstance(row, dict):
        return row.get(key, default)
    try:
        keys = row.keys()
    except AttributeError:
        return default
    if key in keys:
        val = row[key]
        return val if val is not None else default
    return default


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

STATUSES = {"active", "paused", "budget_limited", "complete", "blocked", "delegated"}
PRIORITIES = {"critical", "high", "normal", "low"}
MAX_OBJECTIVE_CHARS = 4000
STATE_DIR = Path(os.environ.get("CLAUDE_GOAL_HOME", Path.home() / ".claude" / "goal"))
DB_PATH = Path(os.environ.get("CLAUDE_GOAL_DB", STATE_DIR / "goals.sqlite"))

# The Collective agent names — used for validation and routing
COLLECTIVE_AGENTS = {
    "melanie",   # CEO / orchestrator
    "james",     # comms
    "annika",    # research
    "sean",      # ops
    "melissa",   # content
    "jackson",   # CRM / sales
}

# Hive Mind CLI path (resolved at runtime)
HIVE_CLI = os.environ.get(
    "COLLECTIVE_HIVE_CLI",
    str(Path(os.environ.get("CLAUDECLAW_PROJECT_ROOT", "")) / "dist" / "hive-cli.js"),
)

# ---------------------------------------------------------------------------
# RecursiveMAS 6-Layer Architecture
# ---------------------------------------------------------------------------
# All 6 layers share: 768-dim latent vectors, 0.02 convergence threshold,
# round budgets from RECURSION_DEPTH_MAP, Hermes transport for messaging.

RECURSIVEMAS_LAYERS = {
    "L1": {"name": "GitNexus", "role": "structural", "segment": (0, 128),
            "signals": ["graph_structure", "high_centrality", "deep_inheritance"]},
    "L2": {"name": "DeepSec", "role": "security", "segment": (128, 256),
            "signals": ["gate_pass", "gate_fail", "gate_review"]},
    "L3": {"name": "BorgArc", "role": "acquisition", "segment": (256, 384),
            "signals": ["absorb", "skip", "review"]},
    "L4": {"name": "Hermes", "role": "transport", "segment": (384, 448),
            "signals": ["message_sent", "message_received", "convergence_reached", "round_complete"]},
    "L5": {"name": "Ax", "role": "reasoning", "segment": (448, 576),
            "signals": ["playbook_entry", "curator_accept", "curator_reject"]},
    "L6": {"name": "BorgQueen", "role": "coordination", "segment": (576, 704),
            "signals": ["cluster_init", "credit_update", "capability_gap", "global_broadcast"]},
}

LATENT_DIM = 768
CONVERGENCE_THRESHOLD = 0.02
RECURSION_DEPTH_MAP = {"linear": 3, "moderate": 4, "complex": 8}

# Hermes trace directory (for linking goal events to latent traces)
HERMES_TRACE_DIR = Path(os.environ.get(
    "HERMES_TRACE_DIR",
    str(Path(os.environ.get("CLAUDECLAW_PROJECT_ROOT", "")) / "store" / "hermes-traces"),
))

# Layer event output directory (goal events emitted for layer consumption)
LAYER_EVENT_DIR = Path(os.environ.get(
    "LAYER_EVENT_DIR",
    str(STATE_DIR / "layer-events"),
))

# ---------------------------------------------------------------------------
# Humanization rules — enforced during completion audit
# ---------------------------------------------------------------------------

# Patterns that MUST NOT appear in any output the goal produces
EM_DASH_PATTERN = re.compile(r"[\u2014\u2013]")  # — and –
AI_CLICHE_PATTERNS = [
    re.compile(p, re.IGNORECASE) for p in [
        r"\bcertainly\b[!.]",
        r"\bgreat question\b",
        r"\bi'?d be happy to\b",
        r"\bas an ai\b",
        r"\bof course[!]",
        r"\bdelve\b",
        r"\btapestry\b",
        r"\blandscape\b(?:\s+of)",
        r"\bunlock(?:ing)?\s+(?:the\s+)?(?:full\s+)?potential\b",
        r"\bgame[- ]?changer\b",
        r"\bseamless(?:ly)?\b",
        r"\bleverage\b(?:\s+(?:the|our|your))",
        r"\bsynerg(?:y|ies|istic)\b",
        r"\bholistic\b",
        r"\brobust\b(?:\s+(?:solution|approach|framework))",
        r"\bcut(?:ting)?[- ]?edge\b",
        r"\bparadigm\s+shift\b",
        r"\bdeep\s+dive\b",
        r"\bthought\s+leader\b",
        r"\bmove\s+the\s+needle\b",
        r"\blow[- ]?hanging\s+fruit\b",
        r"\bbest[- ]?in[- ]?class\b",
        r"\bneedle[- ]?mover\b",
        r"\bsupercharge\b",
        r"\bempower(?:ing|ment)?\b",
    ]
]


def check_humanization(text: str) -> list[str]:
    """Return list of humanization violations found in text."""
    violations = []
    if EM_DASH_PATTERN.search(text):
        violations.append("CRITICAL: Em dash or en dash detected. Use commas, colons, semicolons, or restructure the sentence.")
    for pattern in AI_CLICHE_PATTERNS:
        matches = pattern.findall(text)
        if matches:
            violations.append(f"AI cliche detected: '{matches[0]}'. Rewrite in natural human voice.")
    return violations


# ---------------------------------------------------------------------------
# Time and token formatting
# ---------------------------------------------------------------------------

def now() -> int:
    return int(time.time())


def _term_session_id() -> str | None:
    for key in ("TERM_SESSION_ID", "ITERM_SESSION_ID"):
        value = os.environ.get(key)
        if value:
            return "term:" + hashlib.sha256(value.encode()).hexdigest()[:16]
    return None


def session_id() -> str:
    for key in ("CLAUDE_GOAL_SESSION_ID", "CLAUDE_SESSION_ID"):
        value = os.environ.get(key)
        if value:
            return value
    term = _term_session_id()
    if term:
        return term
    cwd = os.environ.get("PWD") or str(Path.cwd())
    return "cwd:" + hashlib.sha256(cwd.encode()).hexdigest()[:16]


def cwd_session_id(cwd: str | None) -> str | None:
    if not cwd:
        return None
    return "cwd:" + hashlib.sha256(cwd.encode()).hexdigest()[:16]


def fmt_elapsed(seconds: int) -> str:
    seconds = max(0, int(seconds))
    if seconds < 60:
        return f"{seconds}s"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}m"
    hours, rem_minutes = divmod(minutes, 60)
    if hours >= 24:
        days, rem_hours = divmod(hours, 24)
        return f"{days}d {rem_hours}h {rem_minutes}m"
    return f"{hours}h" if rem_minutes == 0 else f"{hours}h {rem_minutes}m"


def fmt_tokens(value: int | None) -> str:
    if value is None:
        return "none"
    value = int(value)
    abs_value = abs(value)
    if abs_value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M".replace(".0M", "M")
    if abs_value >= 1_000:
        return f"{value / 1_000:.1f}K".replace(".0K", "K")
    return str(value)


def parse_tokens(text: str) -> int:
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*", text)
    if not match:
        raise ValueError(f"invalid token budget: {text!r}")
    number = float(match.group(1))
    suffix = match.group(2).lower()
    multiplier = 1_000_000 if suffix == "m" else 1_000 if suffix == "k" else 1
    value = int(number * multiplier)
    if value <= 0:
        raise ValueError("goal budgets must be positive when provided")
    return value


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def sqlite_connect(path: Path = DB_PATH) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    init_db(conn)
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS goals (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL UNIQUE,
            objective TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'budget_limited', 'complete', 'blocked', 'delegated')),
            token_budget INTEGER,
            tokens_used INTEGER NOT NULL DEFAULT 0,
            time_used_seconds INTEGER NOT NULL DEFAULT 0,
            active_started_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            completed_at INTEGER,
            source TEXT NOT NULL DEFAULT 'claude',
            metadata_json TEXT NOT NULL DEFAULT '{}',
            -- Collective extensions
            agent TEXT,
            priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('critical', 'high', 'normal', 'low')),
            parent_goal_id TEXT REFERENCES goals(id),
            delegation_target TEXT,
            completion_evidence TEXT,
            -- RecursiveMAS 6-layer integration
            layer_context TEXT NOT NULL DEFAULT '{}',
            cluster_id TEXT,
            trace_refs TEXT NOT NULL DEFAULT '[]',
            credit_score REAL NOT NULL DEFAULT 0.0,
            complexity TEXT DEFAULT 'moderate'
        );
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            goal_id TEXT,
            session_id TEXT NOT NULL,
            event TEXT NOT NULL,
            detail TEXT,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_goals_agent ON goals(agent);
        CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals(parent_goal_id);
        CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
        CREATE INDEX IF NOT EXISTS idx_events_goal ON events(goal_id);
        """
    )
    # Migrate existing DBs: add columns if missing
    _migrate_add_columns(conn)
    conn.commit()


def _migrate_add_columns(conn: sqlite3.Connection) -> None:
    """Add Collective extension columns to existing DBs without breaking."""
    existing = {row[1] for row in conn.execute("PRAGMA table_info(goals)").fetchall()}
    migrations = [
        ("agent", "TEXT"),
        ("priority", "TEXT NOT NULL DEFAULT 'normal'"),
        ("parent_goal_id", "TEXT"),
        ("delegation_target", "TEXT"),
        ("completion_evidence", "TEXT"),
        # RecursiveMAS columns
        ("layer_context", "TEXT NOT NULL DEFAULT '{}'"),
        ("cluster_id", "TEXT"),
        ("trace_refs", "TEXT NOT NULL DEFAULT '[]'"),
        ("credit_score", "REAL NOT NULL DEFAULT 0.0"),
        ("complexity", "TEXT DEFAULT 'moderate'"),
    ]
    for col_name, col_type in migrations:
        if col_name not in existing:
            try:
                conn.execute(f"ALTER TABLE goals ADD COLUMN {col_name} {col_type}")
            except sqlite3.OperationalError:
                pass  # Column already exists (race condition)


def execute(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Cursor:
    cur = conn.execute(sql, params)
    conn.commit()
    return cur


def event(conn: sqlite3.Connection, sid: str, event_name: str, detail: str | None = None, goal_id: str | None = None) -> None:
    execute(
        conn,
        "INSERT INTO events(goal_id, session_id, event, detail, created_at) VALUES (?, ?, ?, ?, ?)",
        (goal_id, sid, event_name, detail, now()),
    )


# ---------------------------------------------------------------------------
# Goal state helpers
# ---------------------------------------------------------------------------

def active_time(row: sqlite3.Row) -> int:
    used = int(row["time_used_seconds"] or 0)
    if row["status"] == "active" and row["active_started_at"]:
        used += max(0, now() - int(row["active_started_at"]))
    return used


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    data["current_time_used_seconds"] = active_time(row)
    data["metadata"] = json.loads(data.pop("metadata_json", "{}") or "{}")
    return data


def get_goal(conn: sqlite3.Connection, sid: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM goals WHERE session_id = ?", (sid,)).fetchone()


def get_first_goal(conn: sqlite3.Connection, session_ids: list[str]) -> sqlite3.Row | None:
    for sid in session_ids:
        goal = get_goal(conn, sid)
        if goal:
            return goal
    return None


def candidate_session_ids(hook_data: dict[str, Any] | None = None) -> list[str]:
    out: list[str] = []
    sources: list[str | None] = [
        os.environ.get("CLAUDE_GOAL_SESSION_ID"),
        os.environ.get("CLAUDE_SESSION_ID"),
    ]
    if hook_data:
        sources.append(hook_data.get("session_id"))
        sources.append(cwd_session_id(hook_data.get("cwd")))
    sources.append(_term_session_id())
    cwd = os.environ.get("PWD") or str(Path.cwd())
    sources.append("cwd:" + hashlib.sha256(cwd.encode()).hexdigest()[:16])
    sources.append(session_id())
    for value in sources:
        if value and value not in out:
            out.append(value)
    return out


def find_goal(
    conn: sqlite3.Connection,
    candidates: list[str],
    *,
    only_active: bool = False,
) -> sqlite3.Row | None:
    matches: list[sqlite3.Row] = []
    for sid in candidates:
        row = get_goal(conn, sid)
        if row and (not only_active or row["status"] == "active"):
            matches.append(row)
    if matches:
        return max(matches, key=lambda r: r["updated_at"] or 0)
    return None


# ---------------------------------------------------------------------------
# Hive Mind integration
# ---------------------------------------------------------------------------

def hive_log(action: str, detail: str) -> None:
    """Log goal event to The Collective's Hive Mind for cross-agent visibility."""
    if not os.path.isfile(HIVE_CLI):
        return  # Hive CLI not available (standalone installs, tests)
    try:
        subprocess.run(
            ["node", HIVE_CLI, "log", action, detail],
            capture_output=True,
            timeout=5,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass  # Non-critical; don't let hive failures block goal operations


# ---------------------------------------------------------------------------
# RecursiveMAS 6-layer integration
# ---------------------------------------------------------------------------

def emit_layer_event(goal_id: str, event_type: str, layer: str, payload: dict[str, Any]) -> None:
    """Emit goal event in Hermes-compatible format for layer consumption.

    Events written to LAYER_EVENT_DIR as JSONL for pickup by any layer.
    Format matches Hermes TransportEvent schema so L4 can route natively.
    """
    if not layer or layer not in RECURSIVEMAS_LAYERS:
        return
    try:
        LAYER_EVENT_DIR.mkdir(parents=True, exist_ok=True)
        event_record = {
            "id": str(uuid.uuid4()),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "type": event_type,
            "source": "collective-goal",
            "layer": layer,
            "layer_name": RECURSIVEMAS_LAYERS[layer]["name"],
            "goal_id": goal_id,
            "payload": payload,
            "latent_dim": LATENT_DIM,
        }
        event_file = LAYER_EVENT_DIR / "goal-events.jsonl"
        with open(event_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(event_record) + "\n")
    except OSError:
        pass  # Non-critical; graceful degradation like hive_log


def attach_layer_context(conn: sqlite3.Connection, goal_id: str, layers: list[str],
                          cluster_id: str | None = None, complexity: str | None = None) -> None:
    """Associate goal with specific RecursiveMAS layers it interacts with.

    layer_context JSON format:
    {
        "layers": ["L1", "L4", "L6"],
        "signals_expected": ["graph_structure", "convergence_reached", "cluster_init"],
        "round_budget": 4
    }
    """
    valid_layers = [l for l in layers if l in RECURSIVEMAS_LAYERS]
    if not valid_layers:
        return

    signals = []
    for l in valid_layers:
        signals.extend(RECURSIVEMAS_LAYERS[l]["signals"])

    comp = complexity or "moderate"
    if comp not in RECURSION_DEPTH_MAP:
        comp = "moderate"

    context = {
        "layers": valid_layers,
        "signals_expected": signals,
        "round_budget": RECURSION_DEPTH_MAP[comp],
    }

    updates: list[str] = ["layer_context = ?", "updated_at = ?"]
    params: list[Any] = [json.dumps(context), now()]

    if cluster_id:
        updates.append("cluster_id = ?")
        params.append(cluster_id)
    if complexity:
        updates.append("complexity = ?")
        params.append(comp)

    params.append(goal_id)
    execute(conn, f"UPDATE goals SET {', '.join(updates)} WHERE id = ?", tuple(params))

    # Emit layer association event for Hermes pickup
    emit_layer_event(goal_id, "goal_layer_attached", valid_layers[0], {
        "layers": valid_layers,
        "complexity": comp,
        "cluster_id": cluster_id,
    })


def record_trace_ref(conn: sqlite3.Connection, goal_id: str, trace_id: str) -> None:
    """Link a Hermes trace ID to this goal for AxACE playbook learning."""
    row = conn.execute("SELECT trace_refs FROM goals WHERE id = ?", (goal_id,)).fetchone()
    if not row:
        return
    refs = json.loads(row["trace_refs"] or "[]")
    if trace_id not in refs:
        refs.append(trace_id)
        execute(conn, "UPDATE goals SET trace_refs = ?, updated_at = ? WHERE id = ?",
                (json.dumps(refs), now(), goal_id))


def update_credit_score(conn: sqlite3.Connection, goal_id: str, delta: float) -> None:
    """Update Borg Queen credit score for this goal's agent contribution."""
    execute(conn, "UPDATE goals SET credit_score = credit_score + ?, updated_at = ? WHERE id = ?",
            (delta, now(), goal_id))


def emit_completion_signal(goal: sqlite3.Row) -> None:
    """On goal completion, emit signals for AxACE playbook learning and Borg Queen credit."""
    trace_refs = json.loads(goal["trace_refs"] or "[]")
    layer_ctx = json.loads(goal["layer_context"] or "{}")
    layers = layer_ctx.get("layers", [])

    # L5 Ax: completion as training signal for playbook entries
    if trace_refs or "L5" in layers:
        emit_layer_event(goal["id"], "goal_completed", "L5", {
            "objective": goal["objective"][:200],
            "agent": goal["agent"],
            "elapsed_seconds": active_time(goal),
            "trace_refs": trace_refs,
            "priority": goal["priority"],
            "complexity": _row_get(goal, "complexity", "moderate"),
            "status": "complete",
        })

    # L6 Borg Queen: completion as cluster coordination signal
    if _row_get(goal, "cluster_id") or "L6" in layers:
        emit_layer_event(goal["id"], "goal_completed", "L6", {
            "cluster_id": _row_get(goal, "cluster_id"),
            "agent": goal["agent"],
            "credit_score": float(_row_get(goal, "credit_score", 0)),
            "objective": goal["objective"][:200],
            "sub_goal_count": 0,  # Populated by caller if needed
        })

    # L4 Hermes: broadcast completion for cross-agent correlation
    emit_layer_event(goal["id"], "goal_completed", "L4", {
        "agent": goal["agent"],
        "objective": goal["objective"][:120],
        "layers_involved": layers,
    })


def get_layer_context(row: sqlite3.Row | None) -> dict[str, Any]:
    """Extract parsed layer_context from a goal row."""
    if not row:
        return {}
    raw = row["layer_context"] if "layer_context" in row.keys() else "{}"
    return json.loads(raw or "{}")


def render_layer_info(conn: sqlite3.Connection, goal_id: str) -> str:
    """Render RecursiveMAS layer integration status for a goal."""
    row = conn.execute("SELECT * FROM goals WHERE id = ?", (goal_id,)).fetchone()
    if not row:
        return "Goal not found."

    ctx = json.loads(row["layer_context"] or "{}")
    traces = json.loads(row["trace_refs"] or "[]")
    lines = ["RecursiveMAS Layer Integration:"]

    layers = ctx.get("layers", [])
    if not layers:
        lines.append("  No layers attached. Use --layer L1,L4 when setting goal.")
        return "\n".join(lines)

    for l in layers:
        info = RECURSIVEMAS_LAYERS.get(l, {})
        lines.append(f"  {l} {info.get('name', '?')} ({info.get('role', '?')}) "
                      f"segment={info.get('segment', '?')}")

    lines.append(f"  Complexity: {_row_get(row, 'complexity', 'moderate')}")
    lines.append(f"  Round budget: {ctx.get('round_budget', '?')}")
    lines.append(f"  Convergence threshold: {CONVERGENCE_THRESHOLD}")

    if _row_get(row, "cluster_id"):
        lines.append(f"  Borg Queen cluster: {row['cluster_id'][:12]}...")
    if traces:
        lines.append(f"  Hermes traces: {len(traces)} linked")
        for t in traces[:5]:
            lines.append(f"    - {t[:16]}...")
    if _row_get(row, "credit_score", 0) != 0:
        lines.append(f"  Credit score: {row['credit_score']:+.2f}")

    return "\n".join(lines)


def render_traces(conn: sqlite3.Connection, goal_id: str) -> str:
    """Render linked Hermes trace references for a goal."""
    row = conn.execute("SELECT trace_refs, objective FROM goals WHERE id = ?", (goal_id,)).fetchone()
    if not row:
        return "Goal not found."
    traces = json.loads(row["trace_refs"] or "[]")
    if not traces:
        return f"No traces linked to goal: {row['objective'][:60]}"
    lines = [f"Hermes Traces for: {row['objective'][:60]}"]
    for t in traces:
        # Check if trace file exists
        trace_file = HERMES_TRACE_DIR / f"{t}.jsonl"
        exists = " (found)" if trace_file.is_file() else ""
        lines.append(f"  - {t}{exists}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Goal CRUD
# ---------------------------------------------------------------------------

def validate_objective(objective: str) -> str:
    objective = objective.strip()
    if not objective:
        raise ValueError("goal objective must not be empty")
    if len(objective) > MAX_OBJECTIVE_CHARS:
        raise ValueError(
            f"goal objective is too long: {len(objective)} characters. "
            f"Limit: {MAX_OBJECTIVE_CHARS} characters. "
            "Put longer instructions in a file and refer to that file in the goal."
        )
    return objective


def set_goal(
    conn: sqlite3.Connection,
    sid: str,
    objective: str,
    token_budget: int | None,
    *,
    agent: str | None = None,
    priority: str = "normal",
    parent_goal_id: str | None = None,
    layers: list[str] | None = None,
    cluster_id: str | None = None,
    complexity: str | None = None,
) -> sqlite3.Row:
    objective = validate_objective(objective)
    if priority not in PRIORITIES:
        raise ValueError(f"invalid priority: {priority}. Must be one of: {', '.join(sorted(PRIORITIES))}")
    if agent and agent.lower() not in COLLECTIVE_AGENTS:
        # Allow unknown agents (extensibility), but normalize known ones
        pass
    agent = agent.lower() if agent else None

    existing = get_goal(conn, sid)
    if existing:
        raise ValueError("this Claude session already has a goal; use: /goal clear, then set a new goal")

    goal_id = str(uuid.uuid4())
    ts = now()
    status = "budget_limited" if token_budget is not None and token_budget <= 0 else "active"
    execute(
        conn,
        """
        INSERT INTO goals (
            id, session_id, objective, status, token_budget, tokens_used,
            time_used_seconds, active_started_at, created_at, updated_at,
            completed_at, source, metadata_json, agent, priority, parent_goal_id
        ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, NULL, 'claude', '{}', ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
            id = excluded.id,
            objective = excluded.objective,
            status = excluded.status,
            token_budget = excluded.token_budget,
            tokens_used = 0,
            time_used_seconds = 0,
            active_started_at = excluded.active_started_at,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            completed_at = NULL,
            source = excluded.source,
            metadata_json = excluded.metadata_json,
            agent = excluded.agent,
            priority = excluded.priority,
            parent_goal_id = excluded.parent_goal_id
        """,
        (goal_id, sid, objective, status, token_budget, ts, ts, ts, agent, priority, parent_goal_id),
    )
    event(conn, sid, "set", objective, goal_id)

    # Hive Mind: broadcast new goal
    agent_label = f" [{agent}]" if agent else ""
    priority_label = f" [{priority}]" if priority != "normal" else ""
    hive_log("goal-set", f"Goal set{agent_label}{priority_label}: {objective[:120]}")

    # RecursiveMAS: attach layer context if specified
    if layers:
        attach_layer_context(conn, goal_id, layers, cluster_id=cluster_id, complexity=complexity)

    return get_goal(conn, sid)  # type: ignore[return-value]


def update_status(conn: sqlite3.Connection, sid: str, status: str) -> sqlite3.Row:
    if status not in STATUSES:
        raise ValueError(f"invalid status: {status}")
    goal = find_goal(conn, candidate_session_ids())
    if not goal:
        raise ValueError("no goal is set for this Claude session")

    used = active_time(goal)
    ts = now()
    active_started_at = ts if status == "active" else None
    completed_at = ts if status == "complete" else goal["completed_at"]
    execute(
        conn,
        """
        UPDATE goals
        SET status = ?, time_used_seconds = ?, active_started_at = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
        """,
        (status, used, active_started_at, ts, completed_at, goal["id"]),
    )
    event(conn, goal["session_id"], status, goal_id=goal["id"])

    # Hive Mind: broadcast status change
    agent_label = f" [{goal['agent']}]" if goal["agent"] else ""
    hive_log(f"goal-{status}", f"Goal {status}{agent_label}: {goal['objective'][:80]}")

    # RecursiveMAS: emit completion signals for L4/L5/L6 consumption
    if status == "complete":
        updated = get_goal(conn, goal["session_id"])
        if updated:
            emit_completion_signal(updated)

    return get_goal(conn, goal["session_id"])  # type: ignore[return-value]


def delegate_goal(conn: sqlite3.Connection, sid: str, target_agent: str) -> sqlite3.Row:
    """Delegate current goal to another Collective agent."""
    target_agent = target_agent.lower().strip()
    goal = find_goal(conn, candidate_session_ids())
    if not goal:
        raise ValueError("no goal is set for this Claude session")

    ts = now()
    used = active_time(goal)
    execute(
        conn,
        """
        UPDATE goals
        SET status = 'delegated', delegation_target = ?, time_used_seconds = ?,
            active_started_at = NULL, updated_at = ?
        WHERE id = ?
        """,
        (target_agent, used, ts, goal["id"]),
    )
    event(conn, goal["session_id"], "delegated", f"to {target_agent}", goal["id"])
    hive_log("goal-delegated", f"Goal delegated to {target_agent}: {goal['objective'][:80]}")

    return get_goal(conn, goal["session_id"])  # type: ignore[return-value]


def clear_goal(conn: sqlite3.Connection, sid: str) -> bool:
    goal = find_goal(conn, candidate_session_ids())
    if goal:
        execute(conn, "DELETE FROM goals WHERE id = ?", (goal["id"],))
        event(conn, goal["session_id"], "clear", goal_id=goal["id"])
        hive_log("goal-clear", f"Goal cleared: {goal['objective'][:80]}")
        return True
    return False


def get_sub_goals(conn: sqlite3.Connection, parent_id: str) -> list[sqlite3.Row]:
    """Get all sub-goals of a parent goal."""
    return conn.execute(
        "SELECT * FROM goals WHERE parent_goal_id = ? ORDER BY created_at",
        (parent_id,),
    ).fetchall()


def get_goal_history(conn: sqlite3.Connection, limit: int = 20, agent: str | None = None) -> list[dict[str, Any]]:
    """Get recent goal history across all sessions, optionally filtered by agent."""
    if agent:
        rows = conn.execute(
            "SELECT * FROM goals WHERE agent = ? ORDER BY updated_at DESC LIMIT ?",
            (agent.lower(), limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM goals ORDER BY updated_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [row_to_dict(r) for r in rows]


def get_active_goals_all_agents(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """Get all active goals across all agents (for Melanie's oversight)."""
    return conn.execute(
        "SELECT * FROM goals WHERE status = 'active' ORDER BY priority, updated_at DESC",
    ).fetchall()


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def parse_set_args(raw: str) -> tuple[str, int | None, str | None, str, str | None, list[str] | None, str | None, str | None]:
    """Parse goal set arguments.

    Returns (objective, budget, agent, priority, parent_id, layers, cluster_id, complexity).
    """
    tokens = shlex.split(raw)
    token_budget = None
    agent = None
    priority = "normal"
    parent_id = None
    layers: list[str] | None = None
    cluster_id: str | None = None
    complexity: str | None = None
    out: list[str] = []
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t in {"--tokens", "--token-budget", "--budget"}:
            i += 1
            if i >= len(tokens):
                raise ValueError(f"{t} requires a value")
            token_budget = parse_tokens(tokens[i])
        elif t.startswith("--tokens="):
            token_budget = parse_tokens(t.split("=", 1)[1])
        elif t.startswith("--token-budget="):
            token_budget = parse_tokens(t.split("=", 1)[1])
        elif t.startswith("--budget="):
            token_budget = parse_tokens(t.split("=", 1)[1])
        elif t in {"--agent", "-a"}:
            i += 1
            if i >= len(tokens):
                raise ValueError(f"{t} requires a value")
            agent = tokens[i]
        elif t.startswith("--agent="):
            agent = t.split("=", 1)[1]
        elif t in {"--priority", "-p"}:
            i += 1
            if i >= len(tokens):
                raise ValueError(f"{t} requires a value")
            priority = tokens[i].lower()
        elif t.startswith("--priority="):
            priority = t.split("=", 1)[1].lower()
        elif t == "--parent":
            i += 1
            if i >= len(tokens):
                raise ValueError(f"{t} requires a value")
            parent_id = tokens[i]
        elif t.startswith("--parent="):
            parent_id = t.split("=", 1)[1]
        # RecursiveMAS flags
        elif t in {"--layer", "--layers", "-l"}:
            i += 1
            if i >= len(tokens):
                raise ValueError(f"{t} requires a value (e.g. L1,L4,L6)")
            layers = [x.strip().upper() for x in tokens[i].split(",") if x.strip()]
            invalid = [x for x in layers if x not in RECURSIVEMAS_LAYERS]
            if invalid:
                raise ValueError(f"invalid layer(s): {', '.join(invalid)}. Valid: {', '.join(sorted(RECURSIVEMAS_LAYERS))}")
        elif t.startswith("--layer=") or t.startswith("--layers="):
            val = t.split("=", 1)[1]
            layers = [x.strip().upper() for x in val.split(",") if x.strip()]
            invalid = [x for x in layers if x not in RECURSIVEMAS_LAYERS]
            if invalid:
                raise ValueError(f"invalid layer(s): {', '.join(invalid)}. Valid: {', '.join(sorted(RECURSIVEMAS_LAYERS))}")
        elif t == "--cluster":
            i += 1
            if i >= len(tokens):
                raise ValueError(f"{t} requires a value")
            cluster_id = tokens[i]
        elif t.startswith("--cluster="):
            cluster_id = t.split("=", 1)[1]
        elif t == "--complexity":
            i += 1
            if i >= len(tokens):
                raise ValueError(f"{t} requires a value")
            complexity = tokens[i].lower()
            if complexity not in RECURSION_DEPTH_MAP:
                raise ValueError(f"invalid complexity: {complexity}. Must be: {', '.join(sorted(RECURSION_DEPTH_MAP))}")
        elif t.startswith("--complexity="):
            complexity = t.split("=", 1)[1].lower()
            if complexity not in RECURSION_DEPTH_MAP:
                raise ValueError(f"invalid complexity: {complexity}. Must be: {', '.join(sorted(RECURSION_DEPTH_MAP))}")
        else:
            out.append(t)
        i += 1
    return " ".join(out), token_budget, agent, priority, parent_id, layers, cluster_id, complexity


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def render_goal(row: sqlite3.Row | None) -> str:
    if not row:
        return "No goal is currently set for this Claude session."
    elapsed = active_time(row)
    parts = [
        "Goal",
        f"- Status: {row['status']}",
        f"- Objective: {row['objective']}",
        f"- Time used: {fmt_elapsed(elapsed)}",
        f"- Tokens used: {fmt_tokens(row['tokens_used'])}",
    ]
    if row["token_budget"] is not None:
        parts.append(f"- Token budget: {fmt_tokens(row['token_budget'])} (soft budget)")
    if row["agent"]:
        parts.append(f"- Agent: {row['agent']}")
    if row["priority"] and row["priority"] != "normal":
        parts.append(f"- Priority: {row['priority']}")
    if row["parent_goal_id"]:
        parts.append(f"- Parent goal: {row['parent_goal_id'][:8]}...")
    if row["delegation_target"]:
        parts.append(f"- Delegated to: {row['delegation_target']}")
    # RecursiveMAS layer context
    ctx = json.loads(row["layer_context"] or "{}" if "layer_context" in row.keys() else "{}")
    if ctx.get("layers"):
        layer_names = [f"{l}({RECURSIVEMAS_LAYERS.get(l, {}).get('name', '?')})" for l in ctx["layers"]]
        parts.append(f"- Layers: {', '.join(layer_names)}")
    cluster_id = _row_get(row, "cluster_id")
    if cluster_id:
        parts.append(f"- Cluster: {cluster_id[:12]}...")
    complexity = _row_get(row, "complexity")
    if complexity and complexity != "moderate":
        parts.append(f"- Complexity: {complexity}")
    return "\n".join(parts)


def render_goal_json(row: sqlite3.Row | None) -> str:
    return json.dumps(row_to_dict(row), indent=2, sort_keys=True)


def render_sub_goals(conn: sqlite3.Connection, parent_id: str) -> str:
    subs = get_sub_goals(conn, parent_id)
    if not subs:
        return "No sub-goals."
    lines = ["Sub-goals:"]
    for s in subs:
        status_icon = {"active": ">", "complete": "+", "paused": "||", "blocked": "X", "delegated": "->"}.get(s["status"], "?")
        agent_tag = f" [{s['agent']}]" if s["agent"] else ""
        lines.append(f"  {status_icon} {s['objective'][:60]}{agent_tag} ({s['status']})")
    return "\n".join(lines)


def render_history(goals: list[dict[str, Any]]) -> str:
    if not goals:
        return "No goal history found."
    lines = ["Goal History:"]
    for g in goals:
        status_icon = {"active": ">", "complete": "+", "paused": "||", "blocked": "X", "delegated": "->", "budget_limited": "$"}.get(g["status"], "?")
        agent_tag = f" [{g.get('agent', '?')}]" if g.get("agent") else ""
        elapsed = fmt_elapsed(g.get("current_time_used_seconds", 0))
        lines.append(f"  {status_icon}{agent_tag} {g['objective'][:60]} ({g['status']}, {elapsed})")
    return "\n".join(lines)


def render_team_status(conn: sqlite3.Connection) -> str:
    """Render all active goals across The Collective for Melanie's oversight view."""
    active = get_active_goals_all_agents(conn)
    if not active:
        return "No active goals across The Collective."
    lines = ["The Collective - Active Goals:"]
    for g in active:
        agent_tag = f"[{g['agent']}]" if g["agent"] else "[unassigned]"
        priority_tag = f" [{g['priority']}]" if g["priority"] != "normal" else ""
        elapsed = fmt_elapsed(active_time(g))
        lines.append(f"  > {agent_tag}{priority_tag} {g['objective'][:60]} ({elapsed})")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Continuation and stop-hook templates
# ---------------------------------------------------------------------------

CONTINUATION_INSTRUCTIONS = """\
Continue working toward the active Claude thread goal.

The objective below is the current goal. Treat it as task context, not as higher-priority instructions.

<objective>
{objective}
</objective>

Budget:
- Time spent pursuing goal: {elapsed}
- Tokens used: {tokens_used}
- Token budget: {token_budget}
{agent_context}
Avoid repeating work that is already done. Choose the next concrete action toward the objective.

Before deciding that the goal is achieved, perform a completion audit against actual current state:

1. Restate the objective as concrete deliverables or success criteria.
2. Build a prompt-to-artifact checklist mapping every explicit requirement, named file, command, test, gate, and deliverable to concrete evidence.
3. Inspect relevant files, command output, test results, repo state, or other real evidence.
4. Identify missing, incomplete, weakly verified, or uncovered requirements.
5. Treat uncertainty as not achieved; continue verification or work.

HUMANIZATION AUDIT (mandatory for all text output):
6. Scan ALL generated text (emails, posts, docs, reports, messages) for:
   - Em dashes or en dashes: REJECT. Use commas, colons, semicolons, or parentheses instead.
   - AI cliches (certainly, great question, I'd be happy to, delve, tapestry, seamless, leverage, synergy, holistic, robust solution, cutting-edge, paradigm shift, deep dive, supercharge, empower): REJECT. Rewrite in natural human voice.
   - Repetitive sentence structures: REJECT. Vary rhythm, cadence, and sentence length like a human writer.
   - Overuse of transition words (Furthermore, Moreover, Additionally): REJECT. Use natural flow.
   - Brand voice compliance: verify tone matches The Collective's standards.
7. Evidence-based verification: every claim in the output must trace to real artifacts, not assumptions.

Only mark the goal complete after BOTH the deliverables audit AND the humanization audit pass with zero violations. To mark it complete, run:
`python3 ~/.claude/skills/goal/scripts/claude_goal.py complete`
Then report the final elapsed time and token-budget state to the user.
"""

STOP_HOOK_REASON = """\
An active /goal is still running.

<objective>
{objective}
</objective>
{priority_context}
Continue working toward the objective. Avoid repeating completed work.

If the objective is fully achieved, first perform the completion audit (including humanization audit), then run:
`python3 ~/.claude/skills/goal/scripts/claude_goal.py complete`

If the goal cannot continue productively because user input is required, explain the blocker clearly. The user can run `/goal pause` or `/goal clear` to stop automatic continuation.
"""


def render_invoke_result(action: str, goal: sqlite3.Row | None, extra: str = "") -> str:
    body = [f"Action: {action}", "", render_goal(goal)]
    if extra:
        body.extend(["", extra])

    if goal and goal["status"] == "active":
        agent_context = ""
        if goal["agent"]:
            agent_context = f"\nAgent: {goal['agent']} (The Collective)\n"
        body.extend(
            [
                "",
                "Claude instructions:",
                CONTINUATION_INSTRUCTIONS.format(
                    objective=goal["objective"],
                    elapsed=fmt_elapsed(active_time(goal)),
                    tokens_used=fmt_tokens(goal["tokens_used"]),
                    token_budget=fmt_tokens(goal["token_budget"]),
                    agent_context=agent_context,
                ),
            ]
        )
    elif goal and goal["status"] == "paused":
        body.extend(["", "Claude instructions: Do not continue this goal until the user runs `/goal resume`."])
    elif goal and goal["status"] == "budget_limited":
        body.extend(["", "Claude instructions: The soft budget is exhausted; summarize progress and ask before continuing."])
    elif goal and goal["status"] == "delegated":
        body.extend([
            "",
            f"Claude instructions: This goal has been delegated to {goal['delegation_target']}. "
            "Do not continue work on it. The delegated agent will pick it up.",
        ])
    elif goal and goal["status"] == "blocked":
        body.extend([
            "",
            "Claude instructions: This goal is blocked. Review the blocker, resolve it if possible, "
            "or explain the blocker to the user. Use `/goal resume` when unblocked.",
        ])
    return "\n".join(body)


# ---------------------------------------------------------------------------
# Core invoke dispatcher
# ---------------------------------------------------------------------------

def invoke(raw_args: str) -> str:
    sid = session_id()
    with sqlite_connect() as conn:
        raw_args = (raw_args or "").strip()
        command = raw_args.split(maxsplit=1)[0].lower() if raw_args else "status"
        rest = raw_args.split(maxsplit=1)[1] if " " in raw_args else ""

        if command in {"status", "show", "get", "menu"}:
            goal = find_goal(conn, candidate_session_ids())
            result = render_invoke_result("status", goal)
            # If there's a goal with sub-goals, show them
            if goal and goal["parent_goal_id"] is None:
                subs = render_sub_goals(conn, goal["id"])
                if "No sub-goals" not in subs:
                    result += "\n\n" + subs
            return result

        if command == "pause":
            return render_invoke_result("pause", update_status(conn, sid, "paused"))

        if command == "resume":
            return render_invoke_result("resume", update_status(conn, sid, "active"))

        if command == "clear":
            cleared = clear_goal(conn, sid)
            return "Goal cleared." if cleared else "No goal to clear."

        if command == "complete":
            return render_invoke_result("complete", update_status(conn, sid, "complete"))

        if command == "block":
            return render_invoke_result("block", update_status(conn, sid, "blocked"),
                                       extra=f"Reason: {rest}" if rest else "")

        if command == "delegate":
            if not rest:
                return "Usage: /goal delegate <agent-name>"
            return render_invoke_result("delegate", delegate_goal(conn, sid, rest))

        if command == "history":
            agent_filter = rest.strip().lower() if rest else None
            goals = get_goal_history(conn, limit=20, agent=agent_filter)
            return render_history(goals)

        if command == "team":
            return render_team_status(conn)

        if command == "check":
            # Run humanization check on the provided text
            if not rest:
                return "Usage: /goal check <text to verify>"
            violations = check_humanization(rest)
            if violations:
                return "Humanization violations found:\n" + "\n".join(f"  - {v}" for v in violations)
            return "Text passes humanization audit."

        if command == "layers":
            goal = find_goal(conn, candidate_session_ids())
            if not goal:
                # Show available layers reference
                lines = ["RecursiveMAS Layers (available for goal attachment):"]
                for lid, info in sorted(RECURSIVEMAS_LAYERS.items()):
                    lines.append(f"  {lid} {info['name']} ({info['role']}) segment={info['segment']}")
                lines.append(f"\nLatent dim: {LATENT_DIM}, convergence: {CONVERGENCE_THRESHOLD}")
                lines.append("Depth map: " + ", ".join(f"{k}={v}" for k, v in sorted(RECURSION_DEPTH_MAP.items())))
                lines.append("\nUsage: /goal --layer L1,L4,L6 <objective>")
                return "\n".join(lines)
            return render_layer_info(conn, goal["id"])

        if command == "traces":
            goal = find_goal(conn, candidate_session_ids())
            if not goal:
                return "No goal set. Traces are linked to active goals."
            if rest and rest.strip():
                # Add a trace reference
                record_trace_ref(conn, goal["id"], rest.strip())
                return f"Trace {rest.strip()[:16]}... linked to goal."
            return render_traces(conn, goal["id"])

        if command == "credit":
            goal = find_goal(conn, candidate_session_ids())
            if not goal:
                return "No goal set."
            if rest and rest.strip():
                try:
                    delta = float(rest.strip())
                    update_credit_score(conn, goal["id"], delta)
                    return f"Credit score updated by {delta:+.2f}"
                except ValueError:
                    return "Usage: /goal credit <+/-delta>"
            score = float(_row_get(goal, "credit_score", 0))
            return f"Current credit score: {score:+.2f}"

        # Default: set a new goal
        objective, budget, agent, priority, parent_id, layers, cluster_id, complexity = parse_set_args(raw_args)
        return render_invoke_result(
            "set",
            set_goal(conn, sid, objective, budget, agent=agent, priority=priority,
                     parent_goal_id=parent_id, layers=layers, cluster_id=cluster_id,
                     complexity=complexity),
        )


# ---------------------------------------------------------------------------
# Stop hook
# ---------------------------------------------------------------------------

def stop_hook() -> int:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError:
        data = {}

    candidates = candidate_session_ids(data)

    with sqlite_connect() as conn:
        goal = find_goal(conn, candidates, only_active=True)
        if not goal or goal["status"] != "active":
            return 0

        max_continues = int(os.environ.get("CLAUDE_GOAL_MAX_STOP_CONTINUES", "500"))
        recent_count = conn.execute(
            """
            SELECT COUNT(*)
            FROM events
            WHERE goal_id = ?
              AND event = 'stop_continue'
              AND created_at >= ?
            """,
            (goal["id"], goal["active_started_at"] or goal["created_at"]),
        ).fetchone()[0]
        if recent_count >= max_continues:
            print(
                json.dumps(
                    {
                        "continue": True,
                        "stopReason": f"/goal auto-continuation stopped after {max_continues} Stop-hook continuations. Run /goal resume or raise CLAUDE_GOAL_MAX_STOP_CONTINUES to continue automatically.",
                    }
                )
            )
            return 0

        priority_context = ""
        if goal["priority"] in ("critical", "high"):
            priority_context = f"\nPriority: {goal['priority'].upper()} - this goal demands focused continuation.\n"

        event(conn, goal["session_id"], "stop_continue", goal_id=goal["id"])
        print(
            json.dumps(
                {
                    "decision": "block",
                    "reason": STOP_HOOK_REASON.format(
                        objective=goal["objective"],
                        priority_context=priority_context,
                    ),
                }
            )
        )
        return 0


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    if argv and argv[0] in {"invoke", "set"}:
        cmd = argv[0]
        raw = " ".join(argv[1:])
        try:
            if cmd == "invoke":
                print(invoke(raw))
            else:
                objective, budget, agent, priority, parent_id, layers, cluster_id, complexity = parse_set_args(raw)
                with sqlite_connect() as conn:
                    print(render_invoke_result(
                        "set",
                        set_goal(conn, session_id(), objective, budget, agent=agent, priority=priority,
                                 parent_goal_id=parent_id, layers=layers, cluster_id=cluster_id,
                                 complexity=complexity),
                    ))
        except Exception as exc:
            print(f"goal error: {exc}", file=sys.stderr)
            return 1
        return 0

    parser = argparse.ArgumentParser(description="The Collective /goal command")
    sub = parser.add_subparsers(dest="cmd")

    p_invoke = sub.add_parser("invoke", help="Process slash-command arguments and print Claude-facing instructions")
    p_invoke.add_argument("args", nargs=argparse.REMAINDER)

    sub.add_parser("status")
    sub.add_parser("pause")
    sub.add_parser("resume")
    sub.add_parser("clear")
    sub.add_parser("complete")
    sub.add_parser("block")
    sub.add_parser("team", help="Show all active goals across The Collective")

    p_delegate = sub.add_parser("delegate")
    p_delegate.add_argument("target", help="Target agent name")

    p_set = sub.add_parser("set")
    p_set.add_argument("args", nargs=argparse.REMAINDER)

    p_json = sub.add_parser("json")
    p_json.add_argument("--session-id", default=session_id())

    p_history = sub.add_parser("history", help="Show goal history")
    p_history.add_argument("--agent", default=None, help="Filter by agent name")
    p_history.add_argument("--limit", type=int, default=20)

    p_check = sub.add_parser("check", help="Run humanization audit on text")
    p_check.add_argument("text", nargs=argparse.REMAINDER)

    sub.add_parser("layers", help="Show RecursiveMAS layer info for active goal or layer reference")

    p_traces = sub.add_parser("traces", help="Show or add Hermes trace references")
    p_traces.add_argument("trace_id", nargs="?", default=None, help="Optional trace ID to link")

    p_credit = sub.add_parser("credit", help="Show or update Borg Queen credit score")
    p_credit.add_argument("delta", nargs="?", default=None, help="Optional +/- delta value")

    sub.add_parser("stop-hook")

    args = parser.parse_args(argv)

    try:
        if args.cmd == "invoke":
            print(invoke(" ".join(args.args)))
        elif args.cmd == "status":
            with sqlite_connect() as conn:
                print(render_invoke_result("status", find_goal(conn, candidate_session_ids())))
        elif args.cmd == "pause":
            with sqlite_connect() as conn:
                print(render_invoke_result("pause", update_status(conn, session_id(), "paused")))
        elif args.cmd == "resume":
            with sqlite_connect() as conn:
                print(render_invoke_result("resume", update_status(conn, session_id(), "active")))
        elif args.cmd == "clear":
            with sqlite_connect() as conn:
                print("Goal cleared." if clear_goal(conn, session_id()) else "No goal to clear.")
        elif args.cmd == "complete":
            with sqlite_connect() as conn:
                print(render_invoke_result("complete", update_status(conn, session_id(), "complete")))
        elif args.cmd == "block":
            with sqlite_connect() as conn:
                print(render_invoke_result("block", update_status(conn, session_id(), "blocked")))
        elif args.cmd == "delegate":
            with sqlite_connect() as conn:
                print(render_invoke_result("delegate", delegate_goal(conn, session_id(), args.target)))
        elif args.cmd == "team":
            with sqlite_connect() as conn:
                print(render_team_status(conn))
        elif args.cmd == "set":
            objective, budget, agent, priority, parent_id, layers, cluster_id, complexity = parse_set_args(" ".join(args.args))
            with sqlite_connect() as conn:
                print(render_invoke_result(
                    "set",
                    set_goal(conn, session_id(), objective, budget, agent=agent, priority=priority,
                             parent_goal_id=parent_id, layers=layers, cluster_id=cluster_id,
                             complexity=complexity),
                ))
        elif args.cmd == "json":
            with sqlite_connect() as conn:
                if args.session_id != session_id():
                    print(render_goal_json(get_goal(conn, args.session_id)))
                else:
                    print(render_goal_json(find_goal(conn, candidate_session_ids())))
        elif args.cmd == "history":
            with sqlite_connect() as conn:
                goals = get_goal_history(conn, limit=args.limit, agent=args.agent)
                print(render_history(goals))
        elif args.cmd == "check":
            text = " ".join(args.text)
            violations = check_humanization(text)
            if violations:
                print("Humanization violations found:")
                for v in violations:
                    print(f"  - {v}")
                raise SystemExit(1)
            print("Text passes humanization audit.")
        elif args.cmd == "layers":
            with sqlite_connect() as conn:
                goal = find_goal(conn, candidate_session_ids())
                if not goal:
                    lines = ["RecursiveMAS Layers (available for goal attachment):"]
                    for lid, info in sorted(RECURSIVEMAS_LAYERS.items()):
                        lines.append(f"  {lid} {info['name']} ({info['role']}) segment={info['segment']}")
                    lines.append(f"\nLatent dim: {LATENT_DIM}, convergence: {CONVERGENCE_THRESHOLD}")
                    lines.append("Depth map: " + ", ".join(f"{k}={v}" for k, v in sorted(RECURSION_DEPTH_MAP.items())))
                    lines.append("\nUsage: /goal --layer L1,L4,L6 <objective>")
                    print("\n".join(lines))
                else:
                    print(render_layer_info(conn, goal["id"]))
        elif args.cmd == "traces":
            with sqlite_connect() as conn:
                goal = find_goal(conn, candidate_session_ids())
                if not goal:
                    print("No goal set. Traces are linked to active goals.")
                elif args.trace_id:
                    record_trace_ref(conn, goal["id"], args.trace_id)
                    print(f"Trace {args.trace_id[:16]}... linked to goal.")
                else:
                    print(render_traces(conn, goal["id"]))
        elif args.cmd == "credit":
            with sqlite_connect() as conn:
                goal = find_goal(conn, candidate_session_ids())
                if not goal:
                    print("No goal set.")
                elif args.delta:
                    try:
                        delta = float(args.delta)
                        update_credit_score(conn, goal["id"], delta)
                        print(f"Credit score updated by {delta:+.2f}")
                    except ValueError:
                        print("Usage: /goal credit <+/-delta>")
                else:
                    score = float(_row_get(goal, "credit_score", 0))
                    print(f"Current credit score: {score:+.2f}")
        elif args.cmd == "stop-hook":
            return stop_hook()
        else:
            parser.print_help()
            return 2
    except Exception as exc:
        print(f"goal error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
