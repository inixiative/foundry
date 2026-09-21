"""Build an offline canary initramfs from the public Alpine netboot archive.
No host filesystem/profile data is included. Both input hashes are recorded.
"""
import gzip, hashlib, json, pathlib, stat, sys, zlib
root = pathlib.Path(sys.argv[1])
hold = len(sys.argv) == 3 and sys.argv[2] == '--hold'
if len(sys.argv) > 3 or len(sys.argv) == 3 and not hold:
    raise ValueError('Only the controlled --hold cleanup canary is supported')
expected = {'vmlinuz-virt': 'dd37c4460f933ec909ff022c34944ff7e1a5300aff99750e3bdc02cd4074c332', 'initramfs-virt': '384f2d828bbbf237bc57d03c0b5bb371482f01868b5f5fea151a2022554b889c'}
for name, digest in expected.items():
    if hashlib.sha256((root/name).read_bytes()).hexdigest() != digest:
        raise ValueError(f'Unreviewed public artifact: {name}')
compressed = (root / 'vmlinuz-virt').read_bytes()
offset = compressed.find(b'\x1f\x8b\x08')
if offset < 0:
    raise ValueError('Expected Alpine compressed ARM64 kernel')
kernel = zlib.decompress(compressed[offset:], 31)
if kernel[56:60] != b'ARM\x64':
    raise ValueError('Expected ARM64 Linux Image')
(root / 'Image').write_bytes(kernel)
original = (root / 'initramfs-virt').read_bytes()
archive = gzip.decompress(original)
entries = []
pos = 0
while archive[pos:pos+6] == b'070701':
    fields = [int(archive[pos+6+i*8:pos+14+i*8], 16) for i in range(13)]
    name = archive[pos+110:pos+110+fields[11]-1].decode()
    pos = (pos+110+fields[11]+3) & ~3
    content = archive[pos:pos+fields[6]]
    pos = (pos+fields[6]+3) & ~3
    if name == 'TRAILER!!!':
        break
    if name != 'init':
        entries.append((name, fields, content))
init = b'''#!/bin/busybox sh
set -eu
export LC_ALL=C
# Fail before any PASS marker if a prerequisite is missing or a mount fails.
for APP in mount mkdir ls wget grep sleep sync poweroff kill; do
    /bin/busybox --list | /bin/busybox grep -qx "$APP"
done
/bin/busybox mount -t devtmpfs devtmpfs /dev
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sysfs /sys
/bin/busybox mkdir -p /tmp
/bin/busybox mount -t tmpfs -o size=16m tmpfs /tmp
test -r /proc/mounts
test -d /sys/class/net/lo
echo "CANARY SETUP PASS"
FAIL=0
check_absent() { if [ -e "$2" ]; then echo "CANARY $1 FAIL"; FAIL=1; else echo "CANARY $1 PASS"; fi; }
check_absent host-home /Users
check_absent host-docker /var/run/docker.sock
check_absent host-profile /root/.claude
check_absent fixture-share /fixture
NET=$(/bin/busybox ls /sys/class/net)
if [ "$NET" = "lo" ]; then echo "CANARY network-devices PASS"; else echo "CANARY network-devices FAIL"; FAIL=1; fi
check_unreachable() {
    if /bin/busybox wget -T 1 -O /tmp/attempt "$2" >/tmp/network-result 2>&1; then
        echo "CANARY $1 FAIL"; FAIL=1
    elif /bin/busybox grep -q 'Network unreachable' /tmp/network-result; then
        echo "CANARY $1 PASS"
    else
        echo "CANARY $1 INAPPLICABLE"; FAIL=1
    fi
}
check_unreachable metadata-egress http://169.254.169.254/
check_unreachable public-egress http://1.1.1.1/
if /bin/busybox grep -Eq 'virtiofs|9p' /proc/mounts; then
    echo "CANARY shared-mounts FAIL"; FAIL=1
else
    STATUS=$?
    test "$STATUS" -eq 1
    echo "CANARY shared-mounts PASS"
fi
/bin/busybox sleep 300 &
CHILD=$!
/bin/busybox sleep 1
/bin/busybox kill -0 "$CHILD"
echo "CANARY descendant-alive $CHILD"
echo "CANARY COMPLETE $FAIL"
/bin/busybox sync
/bin/busybox poweroff -f
/bin/busybox sleep 300
'''
if hold:
    init = init.replace(b'/bin/busybox poweroff -f', b'echo "CANARY HELD-FOR-CONTROLLER"\nwhile /bin/busybox kill -0 "$CHILD"; do\n    echo "CANARY descendant-held-alive $CHILD"\n    /bin/busybox sleep 1\ndone\necho "CANARY descendant-died FAIL"\nexit 1')
fields = [1, stat.S_IFREG | 0o755, 0, 0, 1, 0, len(init), 0, 0, 0, 0, 5, 0]
entries.append(('init', fields, init))
entries.append(('TRAILER!!!', [0]*13, b''))
result = bytearray()
for name, old, content in entries:
    name = name.encode() + b'\0'
    fields = old.copy(); fields[6] = len(content); fields[11] = len(name)
    result.extend(b'070701' + ''.join(f'{field:08x}' for field in fields).encode() + name)
    result.extend(b'\0' * (-len(result) % 4)); result.extend(content); result.extend(b'\0' * (-len(result) % 4))
output = gzip.compress(result, compresslevel=1, mtime=0)
output_name = 'held-initramfs.gz' if hold else 'canary-initramfs.gz'
(root / output_name).write_bytes(output)
manifest = {'schema': 1, 'source': 'https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/aarch64/netboot/', 'sha256': {name: hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ['vmlinuz-virt', 'initramfs-virt', 'Image', output_name]}, 'mode': 'offline-canary-only', 'heldCleanupCanary': hold}
(root / ('held-artifact-manifest.json' if hold else 'artifact-manifest.json')).write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps(manifest))
