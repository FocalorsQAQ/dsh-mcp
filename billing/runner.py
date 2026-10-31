"""JSON stdin/stdout adapter. Customize rules.py, not this transport."""
import importlib.util
import json
import sys


def main():
    request = json.load(sys.stdin)
    if request.get("version") != 1 or request.get("operation") not in ("quote", "settle"):
        raise ValueError("Unsupported billing protocol")
    spec = importlib.util.spec_from_file_location("dsh_user_billing", sys.argv[1])
    rules = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rules)
    result = getattr(rules, request["operation"])(request["input"])
    print(json.dumps({"version": 1, "result": result}, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
