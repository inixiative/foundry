import Foundation
import Virtualization
import CryptoKit

// Controller-owned offline canary VM. No network, disks, shared directories,
// socket devices, host executables, credentials or model runtime are exposed.
final class Probe: NSObject, VZVirtualMachineDelegate {
    var machine: VZVirtualMachine!
    var timer: DispatchSourceTimer!
    var finished = false
    var deadlineReached = false
    let output: URL
    let configuration: VZVirtualMachineConfiguration
    let artifactHashes: [String: String]
    let scopeId = UUID().uuidString.lowercased()
    let startedAt = Date()
    init(kernel: URL, initrd: URL, output: URL) throws {
        self.output = output
        self.configuration = VZVirtualMachineConfiguration()
        self.artifactHashes = try ["kernel": kernel, "initramfs": initrd].mapValues { url in SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined() }
        super.init()
        guard VZVirtualMachine.isSupported else { throw NSError(domain: "unsupported", code: 1) }
        configuration.cpuCount = 1
        configuration.memorySize = 512 * 1024 * 1024
        configuration.platform = VZGenericPlatformConfiguration()
        let loader = VZLinuxBootLoader(kernelURL: kernel)
        loader.initialRamdiskURL = initrd
        loader.commandLine = "console=hvc0 rdinit=/init panic=-1 quiet"
        configuration.bootLoader = loader
        let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
        FileManager.default.createFile(atPath: output.path, contents: nil, attributes: [.posixPermissions: 0o600])
        serial.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: FileHandle(forReadingAtPath: "/dev/null"), fileHandleForWriting: try FileHandle(forWritingTo: output))
        configuration.serialPorts = [serial]
        configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        configuration.networkDevices = []
        configuration.storageDevices = []
        configuration.directorySharingDevices = []
        configuration.socketDevices = []
        try configuration.validate()
        machine = VZVirtualMachine(configuration: configuration)
        machine.delegate = self
    }
    func start() {
        timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 10)
        timer.setEventHandler {
            self.deadlineReached = true
            self.machine.stop { error in self.finish(reason: error == nil ? "deadline-stopped" : "stop-unproved") }
        }
        timer.resume()
        machine.start { result in
            if case .failure = result { self.finish(reason: "start-failed") }
        }
    }
    func guestDidStop(_ virtualMachine: VZVirtualMachine) { finish(reason: deadlineReached ? "deadline-stopped" : "guest-stopped") }
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) { finish(reason: "guest-error") }
    func finish(reason: String) {
        if finished { return }; finished = true; timer.cancel()
        let stopped = machine.state == .stopped
        let receipt: [String: Any] = ["schema": 1, "mode": "offline-vm-canary", "scopeId": scopeId, "artifactHashes": artifactHashes, "reason": reason, "stopped": stopped, "elapsedSeconds": Date().timeIntervalSince(startedAt), "cpuCount": configuration.cpuCount, "memoryBytes": configuration.memorySize, "networkDevices": configuration.networkDevices.count, "storageDevices": configuration.storageDevices.count, "directorySharingDevices": configuration.directorySharingDevices.count, "socketDevices": configuration.socketDevices.count, "deadlineSeconds": 10, "fullWorkerReadiness": false]
        if let data = try? JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) { print(text) }
        exit(stopped && ["guest-stopped", "deadline-stopped"].contains(reason) ? 0 : 1)
    }
}
guard CommandLine.arguments.count == 4 else { fputs("usage: offline-probe kernel initramfs console-output\n", stderr); exit(2) }
do {
    let probe = try Probe(kernel: URL(fileURLWithPath: CommandLine.arguments[1]), initrd: URL(fileURLWithPath: CommandLine.arguments[2]), output: URL(fileURLWithPath: CommandLine.arguments[3]))
    probe.start()
    RunLoop.main.run()
} catch { fputs("Offline VM configuration refused\n", stderr); exit(1) }
