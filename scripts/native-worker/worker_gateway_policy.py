"""Controller-side routing for the controlled worker prototype.

No listener, real DNS/dialer, model authentication or readiness issuer is installed.
A caller must bind the channel to a VZ VM outside the guest, and enforce the returned
route with an IP-pinned bounded dialer. A routing result is never execution admission.
"""
import asyncio
import dataclasses
import hashlib
import ipaddress
import json
import re
import time
import uuid

# Runtime-only candidates. Registration must select an explicit reviewed subset;
# browser login, updates and organization policy fetches need separate review.
RUNTIME_HOSTS = frozenset({'api.anthropic.com', 'claude.ai', 'claude.com', 'platform.claude.com'})
FIXTURE_TOOLS = frozenset({'fixture_read', 'fixture_write', 'fixture_command'})
PATH = re.compile(r'^[A-Za-z0-9_-][A-Za-z0-9_.-]*(/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$')


class Refused(ValueError):
    """A static reason only: never includes request bodies or credential material."""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def exact_keys(value, keys):
    if type(value) is not dict or set(value) != set(keys):
        raise Refused('Unexpected request shape')


def identifier(value):
    try:
        if type(value) is not str or str(uuid.UUID(value)) != value:
            raise ValueError()
    except (ValueError, AttributeError):
        raise Refused('Invalid identifier') from None
    return value


def parse_frame(frame, limit):
    if type(frame) is not bytes or not 0 < len(frame) <= limit:
        raise Refused('Frame exceeds bounds')

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise Refused('Duplicate field')
            result[key] = value
        return result

    def invalid_number(_):
        raise Refused('Invalid number')

    try:
        return json.loads(frame.decode('utf-8', errors='strict'), object_pairs_hook=pairs,
                          parse_constant=invalid_number)
    except (UnicodeError, ValueError, RecursionError):
        raise Refused('Malformed frame') from None


@dataclasses.dataclass(frozen=True)
class Binding:
    worker_id: str
    peer_worker_id: str
    installation_id: str
    admission_id: str
    boundary_digest: str
    role: str

    def __post_init__(self):
        for value in (self.worker_id, self.peer_worker_id, self.installation_id, self.admission_id):
            identifier(value)
        if self.worker_id == self.peer_worker_id or self.role not in ('primary', 'decisions'):
            raise Refused('Invalid role binding')
        if not re.fullmatch('[a-f0-9]{64}', self.boundary_digest):
            raise Refused('Invalid boundary digest')


@dataclasses.dataclass(frozen=True)
class Policy:
    https_hosts: frozenset
    fixture_tools: frozenset
    max_calls: int = 20
    max_input_bytes: int = 280000
    max_output_bytes: int = 280000
    timeout_seconds: float = 2
    lifetime_seconds: float = 60

    def __post_init__(self):
        # Copy caller collections: mutating the source cannot widen this policy.
        object.__setattr__(self, 'https_hosts', frozenset(self.https_hosts))
        object.__setattr__(self, 'fixture_tools', frozenset(self.fixture_tools))
        if not self.https_hosts <= RUNTIME_HOSTS or not self.fixture_tools <= FIXTURE_TOOLS:
            raise Refused('Unsupported route or tool')
        for name, low, high in [('max_calls', 1, 80), ('max_input_bytes', 1, 400000), ('max_output_bytes', 1, 400000)]:
            value = getattr(self, name)
            if type(value) is not int or not low <= value <= high:
                raise Refused('Invalid bounds')
        for value, high in [(self.timeout_seconds, 30), (self.lifetime_seconds, 900)]:
            if type(value) not in (int, float) or not 0 < value <= high:
                raise Refused('Invalid deadline')


def public_ipv4_set(addresses):
    # Refuse a mixed public/private response rather than silently picking a public
    # alternative. IPv6 is deliberately unsupported until its dialer is tested.
    if type(addresses) is not list or not 1 <= len(addresses) <= 8:
        raise Refused('DNS answer exceeds bounds')
    approved = []
    for value in addresses:
        try:
            address = ipaddress.IPv4Address(value)
        except (ipaddress.AddressValueError, TypeError):
            raise Refused('Unsupported address') from None
        if type(value) is not str or str(address) != value or not address.is_global or address.is_multicast or address.is_reserved:
            raise Refused('Non-public address')
        approved.append(value)
    return sorted(set(approved))


def tool_arguments(name, arguments):
    expected = {'fixture_read': {'path'}, 'fixture_write': {'path', 'content'}, 'fixture_command': {'command'}}[name]
    exact_keys(arguments, expected)
    if name in ('fixture_read', 'fixture_write'):
        path = arguments['path']
        if type(path) is not str or len(path) > 256 or len(path.split('/')) > 9 or not PATH.fullmatch(path):
            raise Refused('Invalid fixture path')
    if name == 'fixture_write':
        content = arguments['content']
        if type(content) is not str or len(content.encode('utf-8')) > 262144:
            raise Refused('Content exceeds bounds')
    if name == 'fixture_command':
        command = arguments['command']
        if type(command) is not str or not 1 <= len(command) <= 8000:
            raise Refused('Command exceeds bounds')


class ControlledGateway:
    """One immutable role/admission, one in-flight operation, no automatic retries.

    `current` must consult trusted controller authority; neither the guest nor a
    request supplies identity or endpoint configuration. `resolve` and `call_tool`
    are controlled adapters here; both receive a synchronous authority guard and
    must call it after any internal await, immediately before each side effect.
    A callback contract cannot enforce this in an arbitrary adapter. Production
    implementations require review and race tests at the final write/dial seam.
    Production VZ identity, bounded streams and an
    IP-pinned dialer still need implementation and testing before live use.
    """
    def __init__(self, binding, policy, *, current, resolve, call_tool, clock=time.monotonic):
        if not isinstance(binding, Binding) or not isinstance(policy, Policy):
            raise Refused('Typed binding and policy required')
        if binding.role == 'decisions' and policy.fixture_tools:
            raise Refused('Decision workers have no tools')
        self._binding, self._policy = binding, policy
        self._current, self._resolve, self._call_tool, self._clock = current, resolve, call_tool, clock
        self._deadline = clock() + policy.lifetime_seconds
        self._seen, self._pending = set(), set()
        self._closed = False
        self._calls = 0
        self._policy_digest = hashlib.sha256(canonical({
            'version': 'controlled-worker-gateway-v1', 'binding': dataclasses.asdict(binding),
            'policy': {**dataclasses.asdict(policy), 'https_hosts': sorted(policy.https_hosts),
                       'fixture_tools': sorted(policy.fixture_tools)},
        }).encode()).hexdigest()

    @property
    def binding(self):
        return self._binding

    @property
    def policy(self):
        return self._policy

    @property
    def policy_digest(self):
        return self._policy_digest

    def _check(self):
        if self._closed or self._clock() >= self._deadline or self._current(self.binding) is not True:
            self._closed = True
            raise Refused('Authority unavailable')

    def status(self):
        return {'closed': self._closed, 'pending': len(self._pending),
                'calls': self._calls, 'executionAuthority': 'none', 'fullWorkerReadiness': False}

    def close(self):
        # Closing admission never declares process/VM settlement.
        self._closed = True
        return self.status()

    async def handle(self, frame):
        self._check()
        if self._pending or self._calls >= self.policy.max_calls or len(self._seen) >= 256:
            raise Refused('Gateway budget or concurrency exhausted')
        request = parse_frame(frame, self.policy.max_input_bytes)
        if type(request) is not dict:
            raise Refused('Unexpected request shape')
        request_id = identifier(request.get('id'))
        if request_id in self._seen:
            raise Refused('Replay refused')
        # Count refused frames with valid identities, too; no unlimited probe set.
        self._seen.add(request_id)
        operation_deadline = min(self._deadline, self._clock() + self.policy.timeout_seconds)

        def guard():
            self._check()
            if self._clock() >= operation_deadline:
                self._closed = True
                raise Refused('Operation deadline; settlement unproved')

        kind = request.get('kind')
        if kind == 'https-connect':
            exact_keys(request, {'id', 'kind', 'authority'})
            authority = request['authority']
            allowed = {host + ':443': host for host in self.policy.https_hosts}
            if type(authority) is not str or authority not in allowed:
                raise Refused('Destination refused')
            host = allowed[authority]

            async def work():
                guard()  # Authority may change after create_task schedules this work.
                addresses = public_ipv4_set(await self._resolve(host, guard))
                # No hostname re-resolution is allowed when a future dialer uses
                # this result; original hostname remains TLS SNI/verification name.
                return {'kind': 'resolved-https-route', 'host': host, 'port': 443, 'addresses': addresses}
        elif kind == 'mcp':
            exact_keys(request, {'id', 'kind', 'method', 'params'})
            if self.binding.role != 'primary' or request['method'] != 'tools/call':
                raise Refused('MCP operation refused')
            params = request['params']
            exact_keys(params, {'name', 'arguments'})
            name = params['name']
            if type(name) is not str or name not in self.policy.fixture_tools:
                raise Refused('Tool refused')
            tool_arguments(name, params['arguments'])

            async def work():
                # The adapter retains the trusted existing MCP session. Requests
                # cannot choose its endpoint, headers, owner or credentials.
                guard()  # Check inside the queued task, immediately before the adapter.
                return await self._call_tool(name, params['arguments'], guard)
        else:
            raise Refused('Channel refused')
        guard()
        self._calls += 1
        task = asyncio.create_task(work())
        self._pending.add(task)

        def settled(completed):
            self._pending.discard(completed)
            if not completed.cancelled():
                completed.exception()  # Retrieve a late failure; never publish late data.

        task.add_done_callback(settled)
        timeout = operation_deadline - self._clock()
        try:
            # Do not mistake cancellation of a wrapper for underlying cleanup.
            done, _ = await asyncio.wait({task}, timeout=max(0, timeout))
            if not done:
                raise Refused('Operation deadline; settlement unproved')
            result = task.result()
            guard()
            encoded = canonical(result).encode('utf-8')
            if len(encoded) > self.policy.max_output_bytes:
                raise Refused('Response exceeds bounds')
            # Do not return a mutable object retained by the adapter.
            return {'id': request_id, 'provenance': 'controlled-gateway',
                    'policyDigest': self.policy_digest, 'result': json.loads(encoded)}
        except BaseException:
            self._closed = True
            raise Refused('Operation failed; gateway closed') from None
