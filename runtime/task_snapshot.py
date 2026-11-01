"""Write one immutable, non-secret configuration snapshot per host-supplied turn."""
import json
from pathlib import Path
import runpy
import sys
import uuid

common = runpy.run_path(str(Path(__file__).with_name("state_lock.py")))


def linked(path):
    # Also reject Windows junctions on supported Python versions before 3.12.
    return path.is_symlink() or bool(getattr(path.lstat(), "st_file_attributes", 0) & 0x400)


def run(command):
    snapshot = command["snapshot"]
    chat = str(uuid.UUID(snapshot["chat_id"]))
    turn = str(uuid.UUID(snapshot["turn_id"]))
    root = Path(command["directory"]) / "task-snapshots"
    root.mkdir(exist_ok=True, parents=True)
    if linked(root):
        raise ValueError("Invalid snapshot directory")
    directory = root / chat
    directory.mkdir(exist_ok=True)
    if linked(root) or linked(directory):
        raise ValueError("Invalid snapshot directory")
    target = directory / (turn + ".json")
    current = directory / "current.json"
    with common["guard"](directory / "snapshot.guard"):
        if target.exists():
            if target.is_symlink() or not target.is_file() or target.stat().st_size > 2_000_000:
                raise ValueError("Invalid snapshot file")
            return json.loads(target.read_text(encoding="utf-8"))
        common["atomic_json"](target, snapshot, str(uuid.uuid4()))
        common["atomic_json"](current, {"turn_id": turn}, str(uuid.uuid4()))
        return snapshot


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "snapshot": run(json.loads(sys.stdin.read(2_000_000)))}))
    except Exception:
        print(json.dumps({"ok": False, "code": "TASK_SNAPSHOT_STORAGE"}))
