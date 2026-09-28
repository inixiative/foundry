"""Controlled callbacks only: no DNS, tool, native CLI, socket or model calls."""
import asyncio
import dataclasses
import json
import time
import unittest
import uuid
from worker_gateway_policy import Binding, ControlledGateway, Policy, Refused


def frame(kind='mcp', **extra):
    request = {'id': str(uuid.uuid4()), 'kind': kind}
    request.update({'method': 'tools/call', 'params': {'name': 'fixture_read', 'arguments': {'path': 'input.ts'}}}
                   if kind == 'mcp' else {'authority': 'api.anthropic.com:443'})
    request.update(extra)
    return json.dumps(request).encode()


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    def setup_gateway(self, **overrides):
        self.active = True
        self.calls = []
        self.binding = Binding(*(str(uuid.uuid4()) for _ in range(4)), 'a' * 64, 'primary')
        async def resolve(host, guard):
            guard(); self.calls.append(('resolve', host)); return ['1.1.1.1']
        async def tool(name, arguments, guard):
            guard(); self.calls.append(('tool', name)); return {'content': 'controlled'}
        self.gateway = ControlledGateway(overrides.pop('binding', self.binding),
            overrides.pop('policy', Policy({'api.anthropic.com'}, {'fixture_read'})),
            current=overrides.pop('current', lambda _: self.active),
            resolve=overrides.pop('resolve', resolve), call_tool=overrides.pop('call_tool', tool), **overrides)
        return self.gateway

    async def test_revocation_at_scheduling_boundary_never_calls_adapter(self):
        for kind in ('mcp', 'https-connect'):
            with self.subTest(kind=kind):
                checks = 0
                def current(_):
                    nonlocal checks
                    checks += 1
                    if checks == 2:
                        asyncio.get_running_loop().call_soon(setattr, self, 'active', False)
                    return self.active
                gateway = self.setup_gateway(current=current)
                with self.assertRaises(Refused): await gateway.handle(frame(kind))
                self.assertEqual(self.calls, [])
                self.assertTrue(gateway.status()['closed'])

    async def test_close_at_scheduling_boundary_never_calls_adapter(self):
        gateway = self.setup_gateway()
        pending = asyncio.create_task(gateway.handle(frame()))
        asyncio.get_running_loop().call_soon(gateway.close)
        with self.assertRaises(Refused): await pending
        self.assertEqual(self.calls, [])

    async def test_adapter_rechecks_after_internal_wait_before_side_effect(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def tool(name, args, guard):
            entered.set(); await release.wait(); guard()
            self.calls.append(('write', name)); return {}
        gateway = self.setup_gateway(call_tool=tool)
        pending = asyncio.create_task(gateway.handle(frame()))
        await entered.wait(); self.active = False; release.set()
        with self.assertRaises(Refused): await pending
        self.assertEqual(self.calls, [])

    async def test_timeout_and_cancel_retain_unsettled_work_and_withhold_late_result(self):
        for mode in ('timeout', 'cancel'):
            with self.subTest(mode=mode):
                entered, release, settled = asyncio.Event(), asyncio.Event(), asyncio.Event()
                async def tool(name, args, guard):
                    guard(); entered.set()
                    try: await release.wait(); return {'secret': 'late-result'}
                    finally: settled.set()
                gateway = self.setup_gateway(call_tool=tool, policy=Policy(set(), {'fixture_read'}, timeout_seconds=.01))
                pending = asyncio.create_task(gateway.handle(frame()))
                await entered.wait()
                if mode == 'cancel': pending.cancel()
                with self.assertRaises(Refused): await pending
                self.assertEqual(gateway.status()['pending'], 1)
                self.assertTrue(gateway.status()['closed'])
                with self.assertRaises(Refused): await gateway.handle(frame())
                release.set(); await settled.wait(); await asyncio.sleep(0)
                self.assertEqual(gateway.status()['pending'], 0)
                self.assertTrue(gateway.status()['closed'])

    async def test_no_replay_overlap_or_implicit_command(self):
        gateway = self.setup_gateway()
        request = frame()
        self.assertEqual((await gateway.handle(request))['result'], {'content': 'controlled'})
        with self.assertRaises(Refused): await gateway.handle(request)
        with self.assertRaises(Refused):
            await gateway.handle(frame(params={'name': 'fixture_command', 'arguments': {'command': 'anything'}}))
        self.assertEqual(len(self.calls), 1)
        entered, release = asyncio.Event(), asyncio.Event()
        async def tool(name, args, guard):
            guard(); entered.set(); await release.wait(); guard(); return {}
        gateway = self.setup_gateway(call_tool=tool)
        pending = asyncio.create_task(gateway.handle(frame()))
        await entered.wait()
        with self.assertRaises(Refused): await gateway.handle(frame())
        release.set(); await pending

    async def test_role_and_policy_cannot_be_widened_by_original_collections(self):
        tools, hosts = {'fixture_read'}, {'api.anthropic.com'}
        policy = Policy(hosts, tools)
        tools.add('fixture_command'); hosts.add('claude.ai')
        gateway = self.setup_gateway(policy=policy)
        with self.assertRaises(Refused): await gateway.handle(frame('https-connect', authority='claude.ai:443'))
        with self.assertRaises(dataclasses.FrozenInstanceError): self.binding.role = 'decisions'
        with self.assertRaises(Refused):
            ControlledGateway(dataclasses.replace(self.binding, role='decisions'), policy,
                              current=lambda _: True, resolve=None, call_tool=None)
        decisions = self.setup_gateway(binding=dataclasses.replace(self.binding, role='decisions'), policy=Policy(set(), set()))
        with self.assertRaises(Refused): await decisions.handle(frame())
        self.assertEqual(self.calls, [])

    async def test_dns_and_authority_fail_closed(self):
        for authority in ('127.0.0.1:443', 'api.anthropic.com:80', 'api.anthropic.com.evil:443',
                          'api.anthropic.com:443/path', 'user@api.anthropic.com:443', '[::1]:443'):
            gateway = self.setup_gateway()
            with self.assertRaises(Refused): await gateway.handle(frame('https-connect', authority=authority))
            self.assertEqual(self.calls, [])
        for addresses in (['1.1.1.1', '127.0.0.1'], ['169.254.169.254'], ['10.0.0.1'], ['::1'], ['224.0.0.1']):
            async def resolve(host, guard): guard(); return addresses
            gateway = self.setup_gateway(resolve=resolve)
            with self.assertRaises(Refused): await gateway.handle(frame('https-connect'))
            self.assertTrue(gateway.status()['closed'])

    async def test_malformed_oversized_extra_fields_and_traversal(self):
        gateway = self.setup_gateway()
        for request in (b'{"id":"a","id":"b"}', b'[]', b'\xff', b'x'*280001,
                        frame(endpoint='http://localhost'),
                        frame(params={'name': 'fixture_read', 'arguments': {'path': '../profile'}})):
            with self.assertRaises(Refused): await gateway.handle(request)
        self.assertEqual(self.calls, [])

    async def test_identity_and_policy_replacement_during_wait_are_refused(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def tool(name, args, guard):
            entered.set(); await release.wait(); guard()
            self.calls.append(('write', name)); return {'content': 'must-not-deliver'}
        gateway = self.setup_gateway(call_tool=tool)
        original = gateway.binding
        original_digest = gateway.policy_digest
        pending = asyncio.create_task(gateway.handle(frame()))
        await entered.wait()
        for key, value in [('binding', dataclasses.replace(original, admission_id=str(uuid.uuid4()))),
                           ('policy', Policy(set(), {'fixture_read'}, max_output_bytes=400000)),
                           ('policy_digest', 'b'*64)]:
            with self.assertRaises(AttributeError): setattr(gateway, key, value)
        self.active = False; release.set()
        with self.assertRaises(Refused): await pending
        self.assertIs(gateway.binding, original)
        self.assertEqual(gateway.policy_digest, original_digest)
        self.assertEqual(self.calls, [])

    async def test_operation_deadline_survives_delayed_event_loop_timer(self):
        async def tool(name, args, guard):
            asyncio.get_running_loop().call_soon(time.sleep, .04)
            await asyncio.sleep(.001)
            guard()
            self.calls.append(('write', name)); return {'late': True}
        gateway = self.setup_gateway(call_tool=tool, policy=Policy(set(), {'fixture_read'}, timeout_seconds=.01))
        with self.assertRaises(Refused): await gateway.handle(frame())
        self.assertEqual(self.calls, [])
        self.assertTrue(gateway.status()['closed'])

    async def test_late_result_rejected_even_when_adapter_finishes_synchronously(self):
        async def tool(name, args, guard):
            guard(); time.sleep(.025); return {'late': True}
        gateway = self.setup_gateway(call_tool=tool, policy=Policy(set(), {'fixture_read'}, timeout_seconds=.01))
        with self.assertRaises(Refused): await gateway.handle(frame())
        self.assertTrue(gateway.status()['closed'])

    async def test_expiry_call_budget_and_output_bounds(self):
        now = [1.0]
        gateway = self.setup_gateway(clock=lambda: now[0], policy=Policy(set(), {'fixture_read'}, lifetime_seconds=1))
        now[0] = 2.0
        with self.assertRaises(Refused): await gateway.handle(frame())
        self.assertEqual(self.calls, [])
        gateway = self.setup_gateway(policy=Policy(set(), {'fixture_read'}, max_calls=1))
        await gateway.handle(frame())
        with self.assertRaises(Refused): await gateway.handle(frame())
        self.assertEqual(len(self.calls), 1)
        gateway = self.setup_gateway(policy=Policy(set(), {'fixture_read'}, max_output_bytes=1))
        with self.assertRaises(Refused): await gateway.handle(frame())
        self.assertTrue(gateway.status()['closed'])

    async def test_changed_authority_after_result_never_delivers_data(self):
        async def tool(name, args, guard):
            guard(); self.active = False; return {'secret': 'withheld'}
        gateway = self.setup_gateway(call_tool=tool)
        with self.assertRaises(Refused) as caught: await gateway.handle(frame())
        self.assertNotIn('withheld', str(caught.exception))
        self.assertTrue(gateway.status()['closed'])


if __name__ == '__main__':
    unittest.main()
