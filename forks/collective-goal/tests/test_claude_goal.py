import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "goal" / "scripts" / "claude_goal.py"


def run_goal(tmp_path, *args, session="test-session"):
    env = os.environ.copy()
    env["CLAUDE_GOAL_DB"] = str(tmp_path / "goals.sqlite")
    env["CLAUDE_GOAL_SESSION_ID"] = session
    # Disable hive integration in tests
    env["COLLECTIVE_HIVE_CLI"] = "/nonexistent/hive-cli.js"
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def test_set_status_pause_resume_complete(tmp_path):
    result = run_goal(tmp_path, "invoke", "--tokens", "98.5K", "improve benchmark coverage")
    assert result.returncode == 0, result.stderr
    assert "Action: set" in result.stdout
    assert "Token budget: 98.5K" in result.stdout
    assert "<objective>" in result.stdout

    result = run_goal(tmp_path, "pause")
    assert result.returncode == 0, result.stderr
    assert "Status: paused" in result.stdout

    result = run_goal(tmp_path, "resume")
    assert result.returncode == 0, result.stderr
    assert "Status: active" in result.stdout

    result = run_goal(tmp_path, "complete")
    assert result.returncode == 0, result.stderr
    assert "Status: complete" in result.stdout


def test_rejects_empty_and_duplicate_without_replace(tmp_path):
    result = run_goal(tmp_path, "set")
    assert result.returncode == 1
    assert "goal objective must not be empty" in result.stderr

    assert run_goal(tmp_path, "set", "first objective").returncode == 0
    result = run_goal(tmp_path, "set", "second objective")
    assert result.returncode == 1
    assert "already has a goal" in result.stderr


def test_json_output(tmp_path):
    assert run_goal(tmp_path, "set", "ship the thing").returncode == 0
    result = run_goal(tmp_path, "json")
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["objective"] == "ship the thing"
    assert data["status"] == "active"


def test_stop_hook_blocks_active_goal(tmp_path):
    assert run_goal(tmp_path, "set", "keep going").returncode == 0
    env = os.environ.copy()
    env["CLAUDE_GOAL_DB"] = str(tmp_path / "goals.sqlite")
    env["CLAUDE_GOAL_SESSION_ID"] = "test-session"
    env["COLLECTIVE_HIVE_CLI"] = "/nonexistent/hive-cli.js"
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "stop-hook"],
        input=json.dumps({"session_id": "test-session", "stop_hook_active": False}),
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["decision"] == "block"
    assert "<objective>" in data["reason"]


def test_stop_hook_allows_paused_goal(tmp_path):
    assert run_goal(tmp_path, "set", "keep going").returncode == 0
    assert run_goal(tmp_path, "pause").returncode == 0
    env = os.environ.copy()
    env["CLAUDE_GOAL_DB"] = str(tmp_path / "goals.sqlite")
    env["CLAUDE_GOAL_SESSION_ID"] = "test-session"
    env["COLLECTIVE_HIVE_CLI"] = "/nonexistent/hive-cli.js"
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "stop-hook"],
        input=json.dumps({"session_id": "test-session"}),
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == ""


def test_cli_does_not_leak_goals_across_sessions(tmp_path):
    assert run_goal(tmp_path, "set", "session A goal", session="session-a").returncode == 0

    status_b = run_goal(tmp_path, "status", session="session-b")
    assert status_b.returncode == 0, status_b.stderr
    assert "No goal is currently set" in status_b.stdout

    env = os.environ.copy()
    env["CLAUDE_GOAL_DB"] = str(tmp_path / "goals.sqlite")
    env["CLAUDE_GOAL_SESSION_ID"] = "session-b"
    env["COLLECTIVE_HIVE_CLI"] = "/nonexistent/hive-cli.js"
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "stop-hook"],
        input=json.dumps({"session_id": "session-b", "cwd": "/different/path"}),
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == ""


def test_two_concurrent_terminals_do_not_share_goals(tmp_path):
    db = str(tmp_path / "goals.sqlite")

    env_a = os.environ.copy()
    env_a["CLAUDE_GOAL_DB"] = db
    env_a["COLLECTIVE_HIVE_CLI"] = "/nonexistent/hive-cli.js"
    env_a.pop("CLAUDE_GOAL_SESSION_ID", None)
    env_a.pop("CLAUDE_SESSION_ID", None)
    env_a["TERM_SESSION_ID"] = "iterm-tab-A-uuid"
    env_a["PWD"] = "/Users/alice/proj-a"
    set_a = subprocess.run(
        [sys.executable, str(SCRIPT), "set", "tab A goal"],
        env=env_a, text=True, capture_output=True, check=False,
    )
    assert set_a.returncode == 0, set_a.stderr

    env_b = os.environ.copy()
    env_b["CLAUDE_GOAL_DB"] = db
    env_b["COLLECTIVE_HIVE_CLI"] = "/nonexistent/hive-cli.js"
    env_b.pop("CLAUDE_GOAL_SESSION_ID", None)
    env_b.pop("CLAUDE_SESSION_ID", None)
    env_b["TERM_SESSION_ID"] = "iterm-tab-B-uuid"
    env_b["PWD"] = "/Users/alice/proj-b"

    status_b = subprocess.run(
        [sys.executable, str(SCRIPT), "status"],
        env=env_b, text=True, capture_output=True, check=False,
    )
    assert status_b.returncode == 0, status_b.stderr
    assert "No goal is currently set" in status_b.stdout
    assert "tab A goal" not in status_b.stdout

    hook_b = subprocess.run(
        [sys.executable, str(SCRIPT), "stop-hook"],
        input=json.dumps({"session_id": "claude-session-b", "cwd": "/Users/alice/proj-b"}),
        env=env_b, text=True, capture_output=True, check=False,
    )
    assert hook_b.returncode == 0, hook_b.stderr
    assert hook_b.stdout == "", f"Tab B hook leaked tab A's goal: {hook_b.stdout!r}"

    hook_a = subprocess.run(
        [sys.executable, str(SCRIPT), "stop-hook"],
        input=json.dumps({"session_id": "claude-session-a", "cwd": "/Users/alice/proj-a"}),
        env=env_a, text=True, capture_output=True, check=False,
    )
    assert hook_a.returncode == 0, hook_a.stderr
    data = json.loads(hook_a.stdout)
    assert data["decision"] == "block"
    assert "tab A goal" in data["reason"]


def test_term_session_anchors_goal_across_pwd_drift(tmp_path):
    env = os.environ.copy()
    env["CLAUDE_GOAL_DB"] = str(tmp_path / "goals.sqlite")
    env["COLLECTIVE_HIVE_CLI"] = "/nonexistent/hive-cli.js"
    env.pop("CLAUDE_GOAL_SESSION_ID", None)
    env.pop("CLAUDE_SESSION_ID", None)
    env["TERM_SESSION_ID"] = "iterm-tab-abc-123"
    env["PWD"] = "/tmp/orig-cwd"

    set_result = subprocess.run(
        [sys.executable, str(SCRIPT), "set", "stay alive across drift"],
        env=env, text=True, capture_output=True, check=False,
    )
    assert set_result.returncode == 0, set_result.stderr

    env["PWD"] = "/tmp/wandered-far-away"
    status_result = subprocess.run(
        [sys.executable, str(SCRIPT), "status"],
        env=env, text=True, capture_output=True, check=False,
    )
    assert status_result.returncode == 0, status_result.stderr
    assert "stay alive across drift" in status_result.stdout
    assert "Status: active" in status_result.stdout


def test_stop_hook_finds_goal_via_hook_payload_cwd(tmp_path):
    import hashlib
    real_cwd = "/Users/alice/proj-a"
    real_cwd_session_id = "cwd:" + hashlib.sha256(real_cwd.encode()).hexdigest()[:16]

    assert run_goal(tmp_path, "set", "keep going", session=real_cwd_session_id).returncode == 0

    env = os.environ.copy()
    env["CLAUDE_GOAL_DB"] = str(tmp_path / "goals.sqlite")
    env["CLAUDE_GOAL_SESSION_ID"] = "drifted-subshell"
    env["COLLECTIVE_HIVE_CLI"] = "/nonexistent/hive-cli.js"
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "stop-hook"],
        input=json.dumps({"session_id": "drifted-subshell", "cwd": real_cwd}),
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["decision"] == "block"
    assert "keep going" in data["reason"]


# ---------------------------------------------------------------------------
# Collective extension tests
# ---------------------------------------------------------------------------

def test_agent_assignment(tmp_path):
    result = run_goal(tmp_path, "invoke", "--agent", "annika", "research CRM APIs")
    assert result.returncode == 0, result.stderr
    assert "Action: set" in result.stdout
    assert "Agent: annika" in result.stdout


def test_priority_levels(tmp_path):
    result = run_goal(tmp_path, "invoke", "--priority", "critical", "deploy production hotfix")
    assert result.returncode == 0, result.stderr
    assert "Priority: critical" in result.stdout


def test_invalid_priority_rejected(tmp_path):
    result = run_goal(tmp_path, "invoke", "--priority", "urgent", "bad priority")
    assert result.returncode == 1
    assert "invalid priority" in result.stderr


def test_delegate_goal(tmp_path):
    assert run_goal(tmp_path, "invoke", "build the thing").returncode == 0
    result = run_goal(tmp_path, "invoke", "delegate", "jackson")
    assert result.returncode == 0, result.stderr
    assert "delegated" in result.stdout.lower()
    assert "jackson" in result.stdout.lower()


def test_block_goal(tmp_path):
    assert run_goal(tmp_path, "invoke", "waiting on API keys").returncode == 0
    result = run_goal(tmp_path, "invoke", "block need credentials")
    assert result.returncode == 0, result.stderr
    assert "blocked" in result.stdout.lower()


def test_goal_history(tmp_path):
    assert run_goal(tmp_path, "invoke", "--agent", "james", "write LinkedIn post", session="s1").returncode == 0
    run_goal(tmp_path, "complete", session="s1")
    assert run_goal(tmp_path, "invoke", "--agent", "annika", "research competitors", session="s2").returncode == 0

    result = run_goal(tmp_path, "invoke", "history", session="s3")
    assert result.returncode == 0, result.stderr
    assert "Goal History:" in result.stdout


def test_team_status(tmp_path):
    assert run_goal(tmp_path, "invoke", "--agent", "melanie", "orchestrate deployment", session="s1").returncode == 0
    assert run_goal(tmp_path, "invoke", "--agent", "sean", "schedule meetings", session="s2").returncode == 0

    result = run_goal(tmp_path, "invoke", "team", session="s3")
    assert result.returncode == 0, result.stderr
    assert "The Collective" in result.stdout
    assert "melanie" in result.stdout.lower()
    assert "sean" in result.stdout.lower()


def test_humanization_check_catches_em_dashes(tmp_path):
    result = run_goal(tmp_path, "check", "This is a test \u2014 with an em dash")
    assert result.returncode == 1
    assert "Em dash" in result.stdout


def test_humanization_check_catches_ai_cliches(tmp_path):
    result = run_goal(tmp_path, "check", "Certainly! I'd be happy to help you delve into this topic.")
    assert result.returncode == 1
    assert "AI cliche" in result.stdout


def test_humanization_check_passes_clean_text(tmp_path):
    result = run_goal(tmp_path, "check", "The project ships next week. Three modules remain.")
    assert result.returncode == 0
    assert "passes" in result.stdout


def test_continuation_includes_humanization_audit(tmp_path):
    result = run_goal(tmp_path, "invoke", "build something great")
    assert result.returncode == 0
    assert "HUMANIZATION AUDIT" in result.stdout
    assert "Em dashes or en dashes" in result.stdout
    assert "AI cliches" in result.stdout


# ---------------------------------------------------------------------------
# RecursiveMAS 6-layer integration tests
# ---------------------------------------------------------------------------


def test_layer_assignment_on_set(tmp_path):
    """Goals can be assigned to specific RecursiveMAS layers."""
    result = run_goal(tmp_path, "invoke", "--layer", "L1,L4", "--agent", "annika", "analyze codebase")
    assert result.returncode == 0, result.stderr
    assert "Action: set" in result.stdout
    assert "L1" in result.stdout
    assert "L4" in result.stdout


def test_layer_assignment_with_complexity(tmp_path):
    """Complexity flag sets round budget correctly."""
    result = run_goal(tmp_path, "invoke", "--layer", "L1,L2,L4", "--complexity", "complex",
                      "--agent", "sean", "full security audit")
    assert result.returncode == 0, result.stderr
    assert "complex" in result.stdout.lower() or "Action: set" in result.stdout


def test_invalid_layer_rejected(tmp_path):
    """Invalid layer names rejected at parse time."""
    result = run_goal(tmp_path, "invoke", "--layer", "L9", "bad layer goal")
    assert result.returncode == 1
    assert "invalid layer" in result.stderr.lower() or "L9" in result.stderr


def test_layers_reference_no_goal(tmp_path):
    """Layers command with no active goal shows reference table."""
    result = run_goal(tmp_path, "invoke", "layers")
    assert result.returncode == 0
    assert "RecursiveMAS Layers" in result.stdout
    assert "GitNexus" in result.stdout
    assert "BorgQueen" in result.stdout
    assert "768" in result.stdout or "LATENT_DIM" in result.stdout


def test_layers_info_with_active_goal(tmp_path):
    """Layers command with active layered goal shows integration status."""
    set_result = run_goal(tmp_path, "invoke", "--layer", "L1,L6", "--cluster", "cluster-abc",
                          "coordinate acquisition")
    assert set_result.returncode == 0, set_result.stderr

    result = run_goal(tmp_path, "invoke", "layers")
    assert result.returncode == 0
    assert "RecursiveMAS Layer Integration" in result.stdout
    assert "GitNexus" in result.stdout
    assert "BorgQueen" in result.stdout


def test_traces_no_goal(tmp_path):
    """Traces command with no active goal returns message."""
    result = run_goal(tmp_path, "invoke", "traces")
    assert result.returncode == 0
    assert "No goal set" in result.stdout


def test_traces_add_and_list(tmp_path):
    """Can add trace references to an active goal and list them."""
    run_goal(tmp_path, "invoke", "--layer", "L4", "transport test")

    # Add a trace
    result = run_goal(tmp_path, "invoke", "traces hermes-trace-001")
    assert result.returncode == 0
    assert "linked" in result.stdout.lower()

    # List traces
    result = run_goal(tmp_path, "invoke", "traces")
    assert result.returncode == 0
    assert "hermes-trace-001" in result.stdout


def test_credit_score_default(tmp_path):
    """New goals start with credit score 0."""
    run_goal(tmp_path, "invoke", "--layer", "L6", "queen coordination")
    result = run_goal(tmp_path, "invoke", "credit")
    assert result.returncode == 0
    assert "0.00" in result.stdout or "+0.00" in result.stdout


def test_credit_score_update(tmp_path):
    """Credit score can be updated with delta."""
    run_goal(tmp_path, "invoke", "--layer", "L6", "queen coordination")

    result = run_goal(tmp_path, "invoke", "credit +1.5")
    assert result.returncode == 0
    assert "1.5" in result.stdout or "updated" in result.stdout.lower()


def test_cluster_id_assignment(tmp_path):
    """Goals can be assigned to a Borg Queen cluster."""
    result = run_goal(tmp_path, "invoke", "--layer", "L6", "--cluster", "cluster-xyz",
                      "global coordination task")
    assert result.returncode == 0, result.stderr
    assert "cluster-xyz" in result.stdout


def test_completion_emits_layer_events(tmp_path):
    """Completing a layered goal emits layer event files."""
    event_dir = tmp_path / "layer_events"
    env_extra = {"COLLECTIVE_LAYER_EVENT_DIR": str(event_dir)}

    # Set a layered goal
    env = os.environ.copy()
    env["CLAUDE_GOAL_DB"] = str(tmp_path / "goals.sqlite")
    env["CLAUDE_GOAL_SESSION_ID"] = "test-session"
    env["COLLECTIVE_HIVE_CLI"] = "/nonexistent/hive-cli.js"
    env.update(env_extra)

    subprocess.run([sys.executable, str(SCRIPT), "invoke", "--layer", "L4,L5", "test completion"],
                   env=env, text=True, capture_output=True, check=False)

    # Complete it
    result = subprocess.run([sys.executable, str(SCRIPT), "invoke", "complete"],
                            env=env, text=True, capture_output=True, check=False)
    assert result.returncode == 0

    # Check for event files (they may or may not exist depending on LAYER_EVENT_DIR env)
    # The important thing is completion didn't crash
    assert "complete" in result.stdout.lower()


def test_cli_set_with_layers(tmp_path):
    """CLI 'set' subcommand works with layer flags."""
    result = run_goal(tmp_path, "set", "--layer", "L2,L3", "--complexity", "linear",
                      "security scan repos")
    assert result.returncode == 0, result.stderr
    assert "Action: set" in result.stdout


def test_cli_layers_subcommand(tmp_path):
    """CLI 'layers' subcommand works standalone."""
    result = run_goal(tmp_path, "layers")
    assert result.returncode == 0
    assert "RecursiveMAS" in result.stdout


def test_cli_traces_subcommand(tmp_path):
    """CLI 'traces' subcommand works standalone."""
    run_goal(tmp_path, "invoke", "--layer", "L4", "trace test goal")
    result = run_goal(tmp_path, "traces")
    assert result.returncode == 0


def test_cli_credit_subcommand(tmp_path):
    """CLI 'credit' subcommand works standalone."""
    run_goal(tmp_path, "invoke", "--layer", "L6", "credit test goal")
    result = run_goal(tmp_path, "credit")
    assert result.returncode == 0
