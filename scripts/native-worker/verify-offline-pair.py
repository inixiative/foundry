"""Exercise two offline VMs. Local experiment evidence, never worker readiness."""
import hashlib
import json
import math
import pathlib
import re
import shutil
import subprocess
import sys
import time
import uuid

PUBLIC_INPUTS = {
    'vmlinuz-virt': 'dd37c4460f933ec909ff022c34944ff7e1a5300aff99750e3bdc02cd4074c332',
    'initramfs-virt': '384f2d828bbbf237bc57d03c0b5bb371482f01868b5f5fea151a2022554b889c',
}
CANARIES = ['host-home', 'host-docker', 'host-profile', 'fixture-share',
            'network-devices', 'metadata-egress', 'public-egress', 'shared-mounts']
CONFIG = {'schema': 1, 'mode': 'offline-vm-canary', 'cpuCount': 1,
          'memoryBytes': 512 * 1024 * 1024, 'deadlineSeconds': 10,
          'networkDevices': 0, 'storageDevices': 0,
          'directorySharingDevices': 0, 'socketDevices': 0,
          'fullWorkerReadiness': False, 'stopped': True, 'reason': 'deadline-stopped'}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def publish(path, value):
    temporary = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def validate_controller(receipt, expected_hashes):
    for key, expected in CONFIG.items():
        if type(receipt.get(key)) is not type(expected) or receipt[key] != expected:
            raise ValueError(f'Controller configuration/outcome mismatch: {key}')
    if receipt.get('artifactHashes') != expected_hashes:
        raise ValueError('Controller artifact mismatch')
    elapsed = receipt.get('elapsedSeconds')
    if type(elapsed) not in (int, float) or not math.isfinite(elapsed) or not 9 <= elapsed <= 15:
        raise ValueError('External deadline not proven')
    if str(uuid.UUID(receipt['scopeId'])) != receipt['scopeId']:
        raise ValueError('Invalid controller scope')


def validate_console(console):
    lines = console.replace('\r', '').splitlines()
    required = ['CANARY SETUP PASS', 'CANARY COMPLETE 0', 'CANARY HELD-FOR-CONTROLLER']
    required += [f'CANARY {name} PASS' for name in CANARIES]
    if any(line not in lines for line in required) or any('FAIL' in line or 'INAPPLICABLE' in line for line in lines):
        raise ValueError('Guest canary failed or incomplete')
    children = re.findall(r'^CANARY descendant-alive ([1-9][0-9]*)$', console, re.M)
    if len(children) != 1 or lines.count(f'CANARY descendant-held-alive {children[0]}') < 5:
        raise ValueError('Held descendant liveness not observed')


def run(root):
    root = root.resolve()
    run_id = str(uuid.uuid4())
    run_dir = root / 'runs' / run_id
    run_dir.mkdir(parents=True, mode=0o700)
    latest = root / 'pair-receipt.json'
    result = {'schema': 2, 'runId': run_id, 'mode': 'offline-two-vm-prototype',
              'status': 'running', 'passed': False, 'fullWorkerReadiness': False,
              'runtimeProfiles': False, 'networkTransport': False, 'receipts': [],
              'cleanupProven': False, 'runDirectory': str(run_dir)}
    # Invalidate previous success before input checks or any VM launch.
    publish(latest, result)
    processes = []
    started = time.monotonic()
    try:
        manifest_path = root / 'held-artifact-manifest.json'
        manifest = json.loads(manifest_path.read_text())
        if manifest.get('mode') != 'offline-canary-only' or manifest.get('heldCleanupCanary') is not True:
            raise ValueError('Expected held offline canary manifest')
        for name, expected in PUBLIC_INPUTS.items():
            if digest(root / name) != expected or manifest['sha256'].get(name) != expected:
                raise ValueError(f'Public artifact mismatch: {name}')
        # Snapshot inputs so another sequential run cannot overwrite this run's evidence.
        for name in ['Image', 'held-initramfs.gz', 'offline-probe']:
            shutil.copy2(root / name, run_dir / name)
            if name != 'offline-probe' and digest(run_dir / name) != manifest['sha256'].get(name):
                raise ValueError(f'Derived artifact mismatch: {name}')
        hashes = {'kernel': digest(run_dir / 'Image'), 'initramfs': digest(run_dir / 'held-initramfs.gz')}
        result['expectedArtifactHashes'] = hashes
        result['controllerSha256'] = digest(run_dir / 'offline-probe')
        result['manifestSha256'] = digest(manifest_path)
        for role in ['primary', 'decisions']:
            output = open(run_dir / f'{role}-controller.json', 'w')
            try:
                process = subprocess.Popen([str(run_dir / 'offline-probe'), str(run_dir / 'Image'),
                                            str(run_dir / 'held-initramfs.gz'), str(run_dir / f'{role}-console.log')],
                                           stdout=output, stderr=subprocess.PIPE)
            except BaseException:
                output.close()
                raise
            processes.append((role, process, output))
        for role, process, output in processes:
            _, error = process.communicate(timeout=max(1, 25 - (time.monotonic() - started)))
            output.close()
            (run_dir / f'{role}-stderr.log').write_bytes(error)
            if process.returncode != 0:
                raise ValueError(f'{role}: controller failed ({process.returncode})')
            receipt = json.loads((run_dir / f'{role}-controller.json').read_text())
            validate_controller(receipt, hashes)
            console_path = run_dir / f'{role}-console.log'
            validate_console(console_path.read_text().replace('\r', ''))
            result['receipts'].append({'role': role, 'controller': receipt,
                                       'consoleSha256': digest(console_path), 'guestCanaries': CANARIES})
        if len({item['controller']['scopeId'] for item in result['receipts']}) != 2:
            raise ValueError('Role scopes must differ')
        if time.monotonic() - started > 16:
            raise ValueError('Concurrent role budget exceeded')
        result.update(status='passed', passed=True, cleanupProven=True,
                      reservedMemoryBytes=sum(item['controller']['memoryBytes'] for item in result['receipts']),
                      vCPUCount=sum(item['controller']['cpuCount'] for item in result['receipts']))
    except BaseException as error:
        result.update(status='failed', error=f'{type(error).__name__}: {error}')
    finally:
        # Killing a stuck controller bounds the runner, but does not prove VM cleanup.
        cleanup_errors = []
        for role, process, output in processes:
            try:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=3)
            except Exception as error:
                cleanup_errors.append(f'{role}: {type(error).__name__}')
            finally:
                output.close()
        if cleanup_errors:
            result.update(status='failed', passed=False, cleanupProven=False, cleanupErrors=cleanup_errors)
        result['elapsedSeconds'] = time.monotonic() - started
        publish(run_dir / 'pair-receipt.json', result)
        publish(latest, result)
    print(json.dumps({'passed': result['passed'], 'runId': run_id, 'receipt': str(latest),
                      'elapsedSeconds': result['elapsedSeconds'], 'fullWorkerReadiness': False}))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('usage: verify-offline-pair.py artifact-directory')
    sys.exit(run(pathlib.Path(sys.argv[1])))
