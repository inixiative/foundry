"""Negative evidence tests; these never launch a VM."""
import contextlib
import copy
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('probe', pathlib.Path(__file__).with_name('verify-offline-pair.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.hashes = {'kernel': 'a' * 64, 'initramfs': 'b' * 64}
        self.receipt = dict(probe.CONFIG, artifactHashes=self.hashes,
                            elapsedSeconds=10.2, scopeId='4dd11bd4-6c57-469c-acfa-4ed2ca7164d7')
        self.console = '\n'.join(['CANARY SETUP PASS', 'CANARY COMPLETE 0',
                                  'CANARY HELD-FOR-CONTROLLER', 'CANARY descendant-alive 123'] +
                                 [f'CANARY {name} PASS' for name in probe.CANARIES] +
                                 ['CANARY descendant-held-alive 123'] * 6)

    def test_rejects_changed_artifact_resource_deadline_and_outcome(self):
        probe.validate_controller(self.receipt, self.hashes)
        for key, value in [('artifactHashes', {'kernel': 'c' * 64, 'initramfs': 'b' * 64}),
                           ('cpuCount', 2), ('memoryBytes', 1024), ('deadlineSeconds', 60),
                           ('networkDevices', 1), ('stopped', False), ('stopped', 1),
                           ('reason', 'stop-unproved'), ('elapsedSeconds', float('nan'))]:
            with self.subTest(key=key, value=value):
                changed = copy.deepcopy(self.receipt)
                changed[key] = value
                with self.assertRaises(ValueError):
                    probe.validate_controller(changed, self.hashes)

    def test_rejects_inapplicable_canary_and_dead_or_different_descendant(self):
        probe.validate_console(self.console)
        variants = [self.console.replace('CANARY SETUP PASS', ''),
                    self.console.replace('CANARY metadata-egress PASS', 'CANARY metadata-egress INAPPLICABLE'),
                    self.console.replace('descendant-held-alive 123', 'descendant-held-alive 456'),
                    self.console.replace('descendant-held-alive 123', 'descendant-started 123'),
                    self.console + '\nCANARY descendant-died FAIL']
        for console in variants:
            with self.assertRaises(ValueError):
                probe.validate_console(console)

    def test_failed_rerun_replaces_old_success_before_any_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            latest = root / 'pair-receipt.json'
            latest.write_text(json.dumps({'passed': True, 'runId': 'old-success'}))
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(probe.run(root), 1)  # No manifest: pre-launch failure.
            result = json.loads(latest.read_text())
            self.assertFalse(result['passed'])
            self.assertFalse(result['cleanupProven'])
            self.assertEqual(result['status'], 'failed')
            self.assertNotEqual(result['runId'], 'old-success')
            self.assertEqual(result, json.loads((pathlib.Path(result['runDirectory']) / 'pair-receipt.json').read_text()))


if __name__ == '__main__':
    unittest.main()
