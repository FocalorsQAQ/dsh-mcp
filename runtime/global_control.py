"""Atomically initialize/update the shared outsourcing switch, without touching chat ledgers."""
import json
from pathlib import Path
import runpy
import sys
import uuid

common = runpy.run_path(str(Path(__file__).with_name("state_lock.py")))
LockError, guard, atomic_json = (common[name] for name in ("LockError", "guard", "atomic_json"))


def read(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
        raise ValueError("Invalid control file")
    state = json.loads(path.read_text(encoding="utf-8"))
    if set(state) != {"version", "revision", "enabled"} or type(state["version"]) is not int or state["version"] != 1:
        raise ValueError("Invalid control state")
    if type(state["revision"]) is not int or not 0 <= state["revision"] < 2**53 - 1 or type(state["enabled"]) is not bool:
        raise ValueError("Invalid control fields")
    return state


def run(command):
    directory = Path(command["directory"])
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "outsourcing.json"
    with guard(directory / "outsourcing.guard"):
        if command["operation"] == "initialize":
            if path.exists() or path.is_symlink():
                return read(path)
            enabled = command["initial_enabled"]
            if type(enabled) is not bool:
                raise ValueError("Invalid initial value")
            # Migrate the original global preference once. Never copy chat tasks or budgets.
            legacy = directory / "state.json"
            if legacy.exists():
                if legacy.is_symlink() or not legacy.is_file():
                    raise ValueError("Invalid legacy file")
                saved = json.loads(legacy.read_text(encoding="utf-8"))
                previous = saved.get("control", {}).get("policy", {}).get("enabled", enabled)
                if type(previous) is not bool:
                    raise ValueError("Invalid legacy switch")
                enabled = previous
            state = {"version": 1, "revision": 0, "enabled": enabled}
        elif command["operation"] == "update":
            state = read(path)
            if type(command["expected_revision"]) is not int or command["expected_revision"] != state["revision"]:
                raise LockError("GLOBAL_CONTROL_CONFLICT", "The global switch changed; refresh before updating.")
            if type(command["enabled"]) is not bool:
                raise ValueError("Invalid enabled value")
            if state["enabled"] == command["enabled"]:
                return state
            state = {**state, "revision": state["revision"] + 1, "enabled": command["enabled"]}
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
