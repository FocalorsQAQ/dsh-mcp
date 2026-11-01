"""Atomically initialize/update the shared outsourcing switch, without touching chat ledgers."""
import json
from pathlib import Path
import runpy
import sys
import uuid

common = runpy.run_path(str(Path(__file__).with_name("state_lock.py")))
LockError, guard, atomic_json = (common[name] for name in ("LockError", "guard", "atomic_json"))


def validate_settings(settings):
    fields = {"enabled", "max_root_agents", "allow_secondary", "max_depth_user", "max_children_user", "round_budget", "task_budget", "billing_currency"}
    if not isinstance(settings, dict) or set(settings) != fields:
        raise ValueError("Invalid settings")
    if type(settings["enabled"]) is not bool or type(settings["allow_secondary"]) is not bool:
        raise ValueError("Invalid switch")
    for name, limit in (("max_root_agents", 32), ("max_depth_user", 32), ("max_children_user", 1000)):
        if type(settings[name]) is not int or not 0 <= settings[name] <= limit:
            raise ValueError("Invalid limit")
    for name in ("round_budget", "task_budget"):
        value = settings[name]
        if value is not None and (not isinstance(value, list) or len(value) != 2 or any(type(v) not in (int, float) or not 0 <= v <= 1_000_000 for v in value)):
            raise ValueError("Invalid budget")
    if settings["billing_currency"] not in ("USD", "CNY"):
        raise ValueError("Invalid currency")
    return settings


def read(path, initial=None):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
        raise ValueError("Invalid control file")
    state = json.loads(path.read_text(encoding="utf-8"))
    if type(state.get("version")) is not int or state["version"] not in (1, 2):
        raise ValueError("Invalid control state")
    if type(state["revision"]) is not int or not 0 <= state["revision"] < 2**53 - 1:
        raise ValueError("Invalid control fields")
    if state["version"] == 1:
        if set(state) != {"version", "revision", "enabled"} or type(state["enabled"]) is not bool or initial is None:
            raise ValueError("Invalid legacy switch")
        return {"version": 2, "revision": state["revision"], "settings": validate_settings({**initial, "enabled": state["enabled"]})}
    if set(state) != {"version", "revision", "settings"}:
        raise ValueError("Invalid control state")
    validate_settings(state["settings"])
    return state


def run(command):
    directory = Path(command["directory"])
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "outsourcing.json"
    with guard(directory / "outsourcing.guard"):
        if command["operation"] == "initialize":
            settings = validate_settings(command["initial_settings"])
            legacy = directory / "state.json"
            if legacy.exists():
                if legacy.is_symlink() or not legacy.is_file():
                    raise ValueError("Invalid legacy file")
                saved = json.loads(legacy.read_text(encoding="utf-8"))
                settings = validate_settings({**settings, **saved.get("control", {}).get("policy", {})})
            if path.exists() or path.is_symlink():
                state = read(path, settings)
            else:
                state = {"version": 2, "revision": 0, "settings": settings}
        elif command["operation"] == "update":
            state = read(path)
            if type(command["expected_revision"]) is not int or command["expected_revision"] != state["revision"]:
                raise LockError("GLOBAL_CONTROL_CONFLICT", "The global switch changed; refresh before updating.")
            settings = validate_settings({**state["settings"], **command["patch"]})
            if state["settings"] == settings:
                return state
            state = {**state, "revision": state["revision"] + 1, "settings": settings}
        else:
            raise ValueError("Invalid operation")
        atomic_json(path, state, str(uuid.uuid4()))
        return state


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "state": run(json.loads(sys.stdin.read(16384)))}))
    except LockError as error:
        print(json.dumps({"ok": False, "code": error.code, "message": error.message}))
    except Exception:
        print(json.dumps({"ok": False, "code": "GLOBAL_CONTROL_STORAGE", "message": "Cannot read or save the global outsourcing switch."}))
