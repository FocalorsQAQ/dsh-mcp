import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


watch = load('codex_watch', 'runtime/codex_watch.py')
startup = load('ui_startup', 'packaging/ui_startup.py')


class FakeRegistry:
    HKEY_CURRENT_USER, REG_SZ, KEY_SET_VALUE = 1, 1, 2
    def __init__(self):
        self.value = None
    def __enter__(self):
        return self
    def __exit__(self, *_):
        pass
    def OpenKey(self, *_):
        return self
    def CreateKey(self, *_):
        return self
    def QueryValueEx(self, *_):
        if self.value is None:
            raise FileNotFoundError()
        return self.value, self.REG_SZ
    def SetValueEx(self, key, name, reserved, kind, value):
        self.value = value
    def DeleteValue(self, *_):
        self.value = None


class DesktopStartupTests(unittest.TestCase):
    def test_detects_desktop_not_cli_or_regular_chatgpt(self):
        self.assertTrue(watch.is_codex_window(r'C:\Program Files\WindowsApps\OpenAI.Codex_1_x64\app\ChatGPT.exe', 'Chrome_WidgetWin_1'))
        self.assertTrue(watch.is_codex_window(r'C:\Apps\Codex\Codex.exe', 'Chrome_WidgetWin_1'))
        self.assertFalse(watch.is_codex_window(r'C:\Apps\Codex\codex.exe', 'ConsoleWindowClass'))
        self.assertFalse(watch.is_codex_window(r'C:\Apps\ChatGPT\ChatGPT.exe', 'Chrome_WidgetWin_1'))
        self.assertFalse(watch.is_codex_window(r'C:\Apps\Codex\electron.exe', 'Chrome_WidgetWin_1'))

    def test_once_per_process_generation_and_close_is_respected(self):
        tracker, launches = watch.LaunchTracker(), []
        first, restarted = (100, 1), (100, 2)
        alive = {first}
        call = lambda: launches.append('open')
        tracker.tick([first, first], alive.__contains__, True, call, 0)
        tracker.tick([first], alive.__contains__, True, call, 10)
        tracker.tick([], alive.__contains__, True, call, 20)  # Hidden/closed window, process still alive.
        tracker.tick([first], alive.__contains__, True, call, 30)
        self.assertEqual(len(launches), 1)
        alive = {restarted}
        tracker.tick([restarted], alive.__contains__, True, call, 40)
        self.assertEqual(len(launches), 2)

    def test_opt_out_does_not_consume_startup_and_failure_is_retried(self):
        tracker, calls = watch.LaunchTracker(), []
        identity = (4, 5)
        def launch():
            calls.append(1)
            if len(calls) == 1:
                raise OSError('fixture')
        tracker.tick([identity], lambda _: True, False, launch, 0)
        self.assertEqual(calls, [])
        self.assertEqual(tracker.tick([identity], lambda _: True, True, launch, 1), [(identity, False)])
        tracker.tick([identity], lambda _: True, True, launch, 2)
        self.assertEqual(len(calls), 1)
        tracker.tick([identity], lambda _: True, True, launch, 11)
        self.assertEqual(len(calls), 2)
        tracker.tick([identity], lambda _: True, True, launch, 30)
        self.assertEqual(len(calls), 2)

    def test_listener_recovery_preserves_close_until_codex_restarts(self):
        tracker, calls = watch.LaunchTracker(), []
        first, restarted = (100, 1), (100, 2)
        tracker.tick([first], lambda _: True, True, lambda: calls.append(1), 0)
        saved = tracker.snapshot()
        recovered = watch.LaunchTracker()
        recovered.restore(saved + [None, {}, {'pid': True, 'created': '1'}, {'pid': 100, 'created': 'invalid'}], lambda key: key == first)
        recovered.tick([first], lambda key: key == first, True, lambda: calls.append(1), 1)
        self.assertEqual(len(calls), 1, 'Restarting the listener must not undo manual closure')
        recovered.tick([restarted], lambda key: key == restarted, True, lambda: calls.append(1), 2)
        self.assertEqual(len(calls), 2, 'A new Codex generation must reopen the control window')
        self.assertEqual(recovered.snapshot(), [{'pid': 100, 'created': '2'}])

    def test_startup_registration_owns_only_its_value(self):
        output = ROOT / '.test-output/startup-unit'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='run-', dir=output) as temporary:
            root = Path(temporary)
            for name in ['bin/python/pythonw.exe', 'runtime/codex_watch.py']:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
            registry = FakeRegistry()
            self.assertEqual(startup.register(root, start=False, registry=registry)['status'], 'registered')
            original = registry.value
            self.assertEqual(original, subprocess.list2cmdline(startup.command(root)))
            self.assertTrue(json.loads((root / startup.RECEIPT).read_text())['registered'])
            self.assertEqual(startup.register(root, start=False, registry=registry)['status'], 'already_registered')
            registry.value = 'user changed command'
            self.assertEqual(startup.register(root, start=False, registry=registry)['status'], 'conflict')
            self.assertEqual(startup.unregister(root, registry=registry)['status'], 'changed_preserved')
            self.assertEqual(registry.value, 'user changed command')
            registry.value = original
            self.assertEqual(startup.unregister(root, registry=registry)['status'], 'removed')
            self.assertIsNone(registry.value)
            registry.value = original
            self.assertEqual(startup.register(root, start=False, registry=registry)['status'], 'not_owned')


if __name__ == '__main__':
    unittest.main()
