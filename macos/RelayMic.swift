import AppKit

// Menu-bar wrapper for relaymic-receiver: shows the app icon in the status
// bar while the receiver runs, lists the current endpoints (click to copy),
// and quits the receiver cleanly from the menu.

// Prefer the receiver bundled inside the .app; fall back to a PATH install.
func receiverCandidates() -> [String] {
    var paths: [String] = []
    if let dir = Bundle.main.executableURL?.deletingLastPathComponent() {
        paths.append(dir.appendingPathComponent("relaymic-receiver").path)
    }
    paths += [
        NSHomeDirectory() + "/.local/bin/relaymic-receiver",
        "/opt/homebrew/bin/relaymic-receiver",
        "/usr/local/bin/relaymic-receiver",
    ]
    return paths
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var receiver: Process?
    private var signalSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ note: Notification) {
        // A plain SIGTERM/SIGINT would kill this process without running
        // applicationWillTerminate, orphaning the receiver. Route them
        // through the normal terminate path instead.
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }

        guard let path = receiverCandidates().first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            fail("relaymic-receiver was not found in the app bundle, ~/.local/bin, /opt/homebrew/bin, or /usr/local/bin.")
            return
        }

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        // Anchor near the right edge so the notch can't swallow the icon;
        // new status items otherwise appear leftmost, where macOS hides
        // them on notched Macs when the menu bar is crowded.
        item.autosaveName = "RelayMicStatus"
        if let button = item.button {
            if let iconPath = Bundle.main.path(forResource: "favicon", ofType: "icns"),
               let appIcon = NSImage(contentsOfFile: iconPath) {
                appIcon.size = NSSize(width: 18, height: 18)
                button.image = appIcon
            } else if let icon = NSImage(systemSymbolName: "mic.fill", accessibilityDescription: "RelayMic") {
                icon.isTemplate = true
                button.image = icon
            } else {
                button.title = "RM"
            }
            button.toolTip = "RelayMic receiver is running"
        }
        let menu = NSMenu()
        menu.delegate = self // rebuilt on every click so endpoints stay current
        item.menu = menu
        statusItem = item

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: path)

        // Finder launches apps with a minimal PATH that excludes user bin dirs.
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\(NSHomeDirectory())/.local/bin:/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        proc.environment = env

        let logPath = NSHomeDirectory() + "/Library/Logs/RelayMic.log"
        FileManager.default.createFile(atPath: logPath, contents: nil)
        if let log = FileHandle(forWritingAtPath: logPath) {
            proc.standardOutput = log
            proc.standardError = log
        }

        proc.terminationHandler = { p in
            DispatchQueue.main.async {
                self.receiver = nil
                if p.terminationStatus != 0 {
                    self.fail("relaymic-receiver exited unexpectedly (status \(p.terminationStatus)). See ~/Library/Logs/RelayMic.log.")
                } else {
                    NSApp.terminate(nil)
                }
            }
        }

        do {
            try proc.run()
            receiver = proc
        } catch {
            fail("Could not start relaymic-receiver: \(error.localizedDescription)")
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    @objc private func copyEndpoint(_ sender: NSMenuItem) {
        guard let url = sender.representedObject as? String else { return }
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(url, forType: .string)
    }

    // The receiver logs its listen URLs at startup; recover the port from
    // there so a future port change doesn't leave stale endpoints here.
    fileprivate func detectPort() -> Int {
        let logPath = NSHomeDirectory() + "/Library/Logs/RelayMic.log"
        if let log = try? String(contentsOfFile: logPath, encoding: .utf8),
           let range = log.range(of: #"https://[0-9.]+:([0-9]+)"#, options: .regularExpression),
           let colon = log[range].lastIndex(of: ":"),
           let port = Int(log[range][log[range].index(after: colon)...]) {
            return port
        }
        return 7420
    }

    fileprivate func localIPv4Addresses() -> [String] {
        var ips: [String] = []
        var seen = Set<String>()
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0 else { return ips }
        defer { freeifaddrs(ifaddr) }
        var ptr = ifaddr
        while let p = ptr {
            let ifa = p.pointee
            ptr = ifa.ifa_next
            guard let sa = ifa.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET),
                  (ifa.ifa_flags & UInt32(IFF_UP)) != 0,
                  (ifa.ifa_flags & UInt32(IFF_LOOPBACK)) == 0 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count),
                              nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let ip = String(cString: host)
            if !ip.hasPrefix("169.254"), seen.insert(ip).inserted {
                ips.append(ip)
            }
        }
        // LAN addresses first, then VPN/tailnet (100.x), then anything else.
        func rank(_ ip: String) -> Int {
            if ip.hasPrefix("192.168.") || ip.hasPrefix("10.") || ip.hasPrefix("172.") { return 0 }
            if ip.hasPrefix("100.") { return 1 }
            return 2
        }
        return ips.sorted { rank($0) < rank($1) }
    }

    func applicationWillTerminate(_ note: Notification) {
        guard let proc = receiver, proc.isRunning else { return }
        let done = DispatchSemaphore(value: 0)
        proc.terminationHandler = { _ in done.signal() }
        proc.terminate() // SIGTERM
        if done.wait(timeout: .now() + 3) == .timedOut {
            kill(proc.processIdentifier, SIGKILL)
            _ = done.wait(timeout: .now() + 1)
        }
    }

    private func fail(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "RelayMic"
        alert.informativeText = message
        alert.runModal()
        NSApp.terminate(nil)
    }
}

extension AppDelegate: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.addItem(NSMenuItem(title: "RelayMic receiver: running", action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        let ips = localIPv4Addresses()
        if ips.isEmpty {
            menu.addItem(NSMenuItem(title: "No network address found", action: nil, keyEquivalent: ""))
        } else {
            menu.addItem(NSMenuItem(title: "Endpoint — click to copy:", action: nil, keyEquivalent: ""))
            let port = detectPort()
            for ip in ips {
                let url = "https://\(ip):\(port)"
                let entry = NSMenuItem(title: url, action: #selector(copyEndpoint(_:)), keyEquivalent: "")
                entry.target = self
                entry.representedObject = url
                entry.indentationLevel = 1
                menu.addItem(entry)
            }
        }
        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: "Quit RelayMic", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
