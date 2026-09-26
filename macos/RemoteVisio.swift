import AppKit
import ServiceManagement

// Menu-bar wrapper for remotevisio-receiver: shows the app icon in the status
// bar while the receiver runs, lists the current endpoints (click to copy),
// offers a start-at-login toggle, and quits the receiver cleanly from the
// menu.

// Remembers that the user switched start-at-login off, so a later launch
// does not quietly switch it back on.
private let loginItemOptOutKey = "loginItemOptOut"
// When on, the receiver is started with -speaker-mute: the Mac's own
// speakers stay silent while its sound is relayed to the sender.
private let speakerMuteKey = "speakerMute"

// UI strings follow the system language; anything not covered falls back to
// English. Keys are shared across the languages below.
private let strings: [String: [String: String]] = [
    "en": [
        "running": "Remote Visio receiver: running",
        "running_tip": "Remote Visio receiver is running",
        "no_addr": "No network address found",
        "endpoint": "Endpoint — click to copy:",
        "login": "Start at Login",
        "uninstall": "Uninstall Remote Visio…",
        "quit": "Quit Remote Visio",
        "mute": "Mute This Mac's Speakers",
        "uninstall_q": "Uninstall Remote Visio?",
        "uninstall_info": "This removes the Remote Visio audio device, the app and its login item. You will be asked for your administrator password. Sound pauses for about a second while the audio system restarts.",
        "uninstall_btn": "Uninstall",
        "cancel": "Cancel",
        "uninstall_failed": "Uninstall failed",
        "also_run": "You can also run {path} from Terminal.",
        "missing_script": "The uninstall script is missing from this copy of Remote Visio. Run `make uninstall` in the source tree instead.",
        "receiver_missing": "remotevisio-receiver was not found in the app bundle, ~/.local/bin, /opt/homebrew/bin, or /usr/local/bin.",
        "exited": "remotevisio-receiver exited unexpectedly (status {n}). See ~/Library/Logs/RemoteVisio.log.",
        "start_failed": "Could not start remotevisio-receiver: {err}",
    ],
    "es": [
        "running": "Receptor Remote Visio: en marcha",
        "running_tip": "El receptor Remote Visio está en marcha",
        "no_addr": "No se encontró ninguna dirección de red",
        "endpoint": "Dirección — clic para copiar:",
        "login": "Abrir al iniciar sesión",
        "uninstall": "Desinstalar Remote Visio…",
        "quit": "Salir de Remote Visio",
        "mute": "Silenciar los altavoces de este Mac",
        "uninstall_q": "¿Desinstalar Remote Visio?",
        "uninstall_info": "Se eliminarán el dispositivo de audio Remote Visio, la app y su elemento de inicio. Se te pedirá la contraseña de administrador. El sonido se detiene un segundo mientras el sistema de audio se reinicia.",
        "uninstall_btn": "Desinstalar",
        "cancel": "Cancelar",
        "uninstall_failed": "La desinstalación falló",
        "also_run": "También puedes ejecutar {path} desde Terminal.",
        "missing_script": "Falta el script de desinstalación en esta copia de Remote Visio. Ejecuta `make uninstall` en el código fuente.",
        "receiver_missing": "No se encontró remotevisio-receiver en la app ni en ~/.local/bin, /opt/homebrew/bin o /usr/local/bin.",
        "exited": "remotevisio-receiver terminó inesperadamente (estado {n}). Consulta ~/Library/Logs/RemoteVisio.log.",
        "start_failed": "No se pudo iniciar remotevisio-receiver: {err}",
    ],
    "fr": [
        "running": "Récepteur Remote Visio : en marche",
        "running_tip": "Le récepteur Remote Visio est en marche",
        "no_addr": "Aucune adresse réseau trouvée",
        "endpoint": "Adresse — cliquer pour copier :",
        "login": "Ouvrir à la connexion",
        "uninstall": "Désinstaller Remote Visio…",
        "quit": "Quitter Remote Visio",
        "mute": "Couper les haut-parleurs de ce Mac",
        "uninstall_q": "Désinstaller Remote Visio ?",
        "uninstall_info": "Cela supprime le périphérique audio Remote Visio, l'app et son élément de connexion. Votre mot de passe administrateur sera demandé. Le son est coupé environ une seconde pendant le redémarrage du système audio.",
        "uninstall_btn": "Désinstaller",
        "cancel": "Annuler",
        "uninstall_failed": "Échec de la désinstallation",
        "also_run": "Vous pouvez aussi exécuter {path} dans le Terminal.",
        "missing_script": "Le script de désinstallation manque dans cette copie de Remote Visio. Exécutez `make uninstall` depuis les sources.",
        "receiver_missing": "remotevisio-receiver est introuvable dans l'app, ~/.local/bin, /opt/homebrew/bin ou /usr/local/bin.",
        "exited": "remotevisio-receiver s'est arrêté de façon inattendue (état {n}). Voir ~/Library/Logs/RemoteVisio.log.",
        "start_failed": "Impossible de démarrer remotevisio-receiver : {err}",
    ],
    "zh": [
        "running": "Remote Visio 接收端：运行中",
        "running_tip": "Remote Visio 接收端正在运行",
        "no_addr": "没有找到网络地址",
        "endpoint": "地址 —— 点击复制：",
        "login": "登录时启动",
        "uninstall": "卸载 Remote Visio…",
        "quit": "退出 Remote Visio",
        "mute": "静音这台 Mac 的扬声器",
        "uninstall_q": "要卸载 Remote Visio 吗？",
        "uninstall_info": "这会删除 Remote Visio 音频设备、这个 App 和它的登录项。系统会要求输入管理员密码。音频系统重启时声音会中断大约一秒。",
        "uninstall_btn": "卸载",
        "cancel": "取消",
        "uninstall_failed": "卸载失败",
        "also_run": "也可以在终端里运行 {path}。",
        "missing_script": "这份 Remote Visio 里缺少卸载脚本。请在源码目录里运行 `make uninstall`。",
        "receiver_missing": "在 App 内、~/.local/bin、/opt/homebrew/bin 或 /usr/local/bin 都没找到 remotevisio-receiver。",
        "exited": "remotevisio-receiver 意外退出（状态 {n}）。见 ~/Library/Logs/RemoteVisio.log。",
        "start_failed": "无法启动 remotevisio-receiver：{err}",
    ],
    "de": [
        "running": "Remote Visio-Empfänger: läuft",
        "running_tip": "Der Remote Visio-Empfänger läuft",
        "no_addr": "Keine Netzwerkadresse gefunden",
        "endpoint": "Adresse — zum Kopieren klicken:",
        "login": "Bei der Anmeldung starten",
        "uninstall": "Remote Visio deinstallieren…",
        "quit": "Remote Visio beenden",
        "mute": "Lautsprecher dieses Macs stummschalten",
        "uninstall_q": "Remote Visio deinstallieren?",
        "uninstall_info": "Das entfernt das Remote Visio-Audiogerät, die App und ihr Anmeldeobjekt. Sie werden nach Ihrem Administrator-Passwort gefragt. Der Ton setzt etwa eine Sekunde aus, während das Audiosystem neu startet.",
        "uninstall_btn": "Deinstallieren",
        "cancel": "Abbrechen",
        "uninstall_failed": "Deinstallation fehlgeschlagen",
        "also_run": "Sie können auch {path} im Terminal ausführen.",
        "missing_script": "In dieser Kopie von Remote Visio fehlt das Deinstallationsskript. Führen Sie `make uninstall` im Quellcode aus.",
        "receiver_missing": "remotevisio-receiver wurde weder in der App noch in ~/.local/bin, /opt/homebrew/bin oder /usr/local/bin gefunden.",
        "exited": "remotevisio-receiver wurde unerwartet beendet (Status {n}). Siehe ~/Library/Logs/RemoteVisio.log.",
        "start_failed": "remotevisio-receiver konnte nicht gestartet werden: {err}",
    ],
    "it": [
        "running": "Ricevitore Remote Visio: in esecuzione",
        "running_tip": "Il ricevitore Remote Visio è in esecuzione",
        "no_addr": "Nessun indirizzo di rete trovato",
        "endpoint": "Indirizzo — clic per copiare:",
        "login": "Apri al login",
        "uninstall": "Disinstalla Remote Visio…",
        "quit": "Esci da Remote Visio",
        "mute": "Silenzia gli altoparlanti di questo Mac",
        "uninstall_q": "Disinstallare Remote Visio?",
        "uninstall_info": "Verranno rimossi il dispositivo audio Remote Visio, l'app e il suo elemento di login. Ti verrà chiesta la password di amministratore. L'audio si interrompe per circa un secondo mentre il sistema audio si riavvia.",
        "uninstall_btn": "Disinstalla",
        "cancel": "Annulla",
        "uninstall_failed": "Disinstallazione non riuscita",
        "also_run": "Puoi anche eseguire {path} dal Terminale.",
        "missing_script": "In questa copia di Remote Visio manca lo script di disinstallazione. Esegui `make uninstall` nel codice sorgente.",
        "receiver_missing": "remotevisio-receiver non è stato trovato nell'app né in ~/.local/bin, /opt/homebrew/bin o /usr/local/bin.",
        "exited": "remotevisio-receiver si è chiuso in modo imprevisto (stato {n}). Vedi ~/Library/Logs/RemoteVisio.log.",
        "start_failed": "Impossibile avviare remotevisio-receiver: {err}",
    ],
    "hi": [
        "running": "Remote Visio रिसीवर: चालू है",
        "running_tip": "Remote Visio रिसीवर चालू है",
        "no_addr": "कोई नेटवर्क पता नहीं मिला",
        "endpoint": "पता — कॉपी करने के लिए क्लिक करें:",
        "login": "लॉगिन पर शुरू करें",
        "uninstall": "Remote Visio हटाएँ…",
        "quit": "Remote Visio बंद करें",
        "mute": "इस Mac के स्पीकर म्यूट करें",
        "uninstall_q": "Remote Visio हटाएँ?",
        "uninstall_info": "इससे Remote Visio ऑडियो डिवाइस, यह ऐप और इसका लॉगिन आइटम हट जाएँगे। आपसे व्यवस्थापक पासवर्ड माँगा जाएगा। ऑडियो सिस्टम के रीस्टार्ट होने के दौरान आवाज़ लगभग एक सेकंड के लिए रुकेगी।",
        "uninstall_btn": "हटाएँ",
        "cancel": "रद्द करें",
        "uninstall_failed": "हटाना विफल रहा",
        "also_run": "आप Terminal से {path} भी चला सकते हैं।",
        "missing_script": "Remote Visio की इस कॉपी में अनइंस्टॉल स्क्रिप्ट नहीं है। सोर्स कोड में `make uninstall` चलाएँ।",
        "receiver_missing": "remotevisio-receiver ऐप में, ~/.local/bin, /opt/homebrew/bin या /usr/local/bin में नहीं मिला।",
        "exited": "remotevisio-receiver अप्रत्याशित रूप से बंद हो गया (स्थिति {n})। ~/Library/Logs/RemoteVisio.log देखें।",
        "start_failed": "remotevisio-receiver शुरू नहीं हो सका: {err}",
    ],
]

private let uiLanguage: String = {
    // "zh-Hans-CN" → "zh", "en-US" → "en"; unknown → "en".
    for code in Locale.preferredLanguages {
        let primary = code.split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init)?.lowercased() ?? ""
        if strings[primary] != nil { return primary }
    }
    return "en"
}()

private func L(_ key: String, _ vars: [String: String] = [:]) -> String {
    var s = strings[uiLanguage]?[key] ?? strings["en"]?[key] ?? key
    for (k, v) in vars { s = s.replacingOccurrences(of: "{\(k)}", with: v) }
    return s
}

// Prefer the receiver bundled inside the .app; fall back to a PATH install.
func receiverCandidates() -> [String] {
    var paths: [String] = []
    if let dir = Bundle.main.executableURL?.deletingLastPathComponent() {
        paths.append(dir.appendingPathComponent("remotevisio-receiver").path)
    }
    paths += [
        NSHomeDirectory() + "/.local/bin/remotevisio-receiver",
        "/opt/homebrew/bin/remotevisio-receiver",
        "/usr/local/bin/remotevisio-receiver",
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
            fail(L("receiver_missing"))
            return
        }

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        // Anchor near the right edge so the notch can't swallow the icon;
        // new status items otherwise appear leftmost, where macOS hides
        // them on notched Macs when the menu bar is crowded.
        item.autosaveName = "RemoteVisioStatus"
        if let button = item.button {
            if let icon = Bundle.main.image(forResource: "MenuIcon") {
                // Black strokes on transparency: as a template image macOS
                // recolours it for light and dark menu bars.
                icon.isTemplate = true
                icon.accessibilityDescription = "Remote Visio"
                button.image = icon
            } else if let icon = NSImage(systemSymbolName: "mic.fill", accessibilityDescription: "Remote Visio") {
                icon.isTemplate = true
                button.image = icon
            } else {
                button.title = "RM"
            }
            button.toolTip = L("running_tip")
        }
        let menu = NSMenu()
        menu.delegate = self // rebuilt on every click so endpoints stay current
        item.menu = menu
        statusItem = item

        registerLoginItemIfInstalled()
        launchReceiver(path: path, fresh: true)
    }

    // A remote Mac reboots; the receiver has to come back without anyone at
    // the keyboard. Only the copy in /Applications is registered: a build
    // sitting in bin/ gets rebuilt and moved, and a login item pointing there
    // would just fail later.
    private func registerLoginItemIfInstalled() {
        guard #available(macOS 13.0, *) else { return }
        guard Bundle.main.bundlePath == "/Applications/RemoteVisio.app" else { return }
        guard !UserDefaults.standard.bool(forKey: loginItemOptOutKey) else { return }
        let service = SMAppService.mainApp
        if service.status != .enabled {
            try? service.register()
        }
    }

    // The receiver reads -speaker-mute at startup, so flipping it means a
    // restart. Its own teardown releases the device cleanly first.
    @objc private func toggleSpeakerMute() {
        let on = !UserDefaults.standard.bool(forKey: speakerMuteKey)
        UserDefaults.standard.set(on, forKey: speakerMuteKey)
        stopReceiver()
        if let path = receiverCandidates().first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            launchReceiver(path: path, fresh: false)
        }
    }

    @objc private func toggleLoginItem() {
        guard #available(macOS 13.0, *) else { return }
        let service = SMAppService.mainApp
        do {
            if service.status == .enabled {
                try service.unregister()
                UserDefaults.standard.set(true, forKey: loginItemOptOutKey)
            } else {
                try service.register()
                UserDefaults.standard.set(false, forKey: loginItemOptOutKey)
            }
        } catch {
            // The menu shows the real state next time it opens; nothing to do.
        }
    }

    // Start the bundled receiver. It exits with status 3 when its audio device
    // stops responding (coreaudiod restarted, e.g. after a driver reinstall);
    // that is a request to be started again, not a failure. The log is
    // truncated once per app launch and appended to on relaunches, so the line
    // explaining why the previous instance exited survives.
    private func launchReceiver(path: String, fresh: Bool) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: path)
        proc.arguments = UserDefaults.standard.bool(forKey: speakerMuteKey) ? ["-speaker-mute"] : []

        // Finder launches apps with a minimal PATH that excludes user bin dirs.
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\(NSHomeDirectory())/.local/bin:/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        proc.environment = env

        let logPath = NSHomeDirectory() + "/Library/Logs/RemoteVisio.log"
        if fresh || !FileManager.default.fileExists(atPath: logPath) {
            FileManager.default.createFile(atPath: logPath, contents: nil)
        }
        if let log = FileHandle(forWritingAtPath: logPath) {
            log.seekToEndOfFile()
            if !fresh, let note = "--- relaunching remotevisio-receiver after it exited with status 3 ---\n".data(using: .utf8) {
                log.write(note)
            }
            proc.standardOutput = log
            proc.standardError = log
        }

        proc.terminationHandler = { p in
            DispatchQueue.main.async {
                self.receiver = nil
                if p.terminationStatus == 3 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.launchReceiver(path: path, fresh: false) }
                } else if p.terminationStatus != 0 {
                    self.fail(L("exited", ["n": String(p.terminationStatus)]))
                } else {
                    NSApp.terminate(nil)
                }
            }
        }

        do {
            try proc.run()
            receiver = proc
        } catch {
            fail(L("start_failed", ["err": error.localizedDescription]))
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
        let logPath = NSHomeDirectory() + "/Library/Logs/RemoteVisio.log"
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
        stopReceiver()
    }

    // Stop the receiver and wait for it. Give it time to release its audio
    // devices and the system audio tap; a SIGKILL mid-teardown is what leaves
    // coreaudiod wedged.
    private func stopReceiver() {
        guard let proc = receiver, proc.isRunning else { return }
        receiver = nil
        let done = DispatchSemaphore(value: 0)
        proc.terminationHandler = { _ in done.signal() }
        proc.terminate() // SIGTERM
        if done.wait(timeout: .now() + 10) == .timedOut {
            kill(proc.processIdentifier, SIGKILL)
            _ = done.wait(timeout: .now() + 1)
        }
    }

    // Menu-driven uninstall: confirm, drop the login item, stop the receiver,
    // then run the bundled uninstall script as root through the standard
    // macOS password dialog. It removes the audio device driver, restarts
    // coreaudiod, deletes the app and forgets the package receipts.
    @objc private func uninstall() {
        let confirm = NSAlert()
        confirm.messageText = L("uninstall_q")
        confirm.informativeText = L("uninstall_info")
        confirm.addButton(withTitle: L("uninstall_btn"))
        confirm.addButton(withTitle: L("cancel"))
        confirm.alertStyle = .warning
        NSApp.activate(ignoringOtherApps: true)
        guard confirm.runModal() == .alertFirstButtonReturn else { return }

        guard let script = Bundle.main.path(forResource: "uninstall", ofType: "sh") else {
            fail(L("missing_script"))
            return
        }

        if #available(macOS 13.0, *) {
            try? SMAppService.mainApp.unregister()
        }
        stopReceiver()

        // Paths come from the bundle; quote them for the shell all the same.
        let quoted = "'" + script.replacingOccurrences(of: "'", with: "'\\''") + "'"
        let source = "do shell script \"\(quoted) --from-app\" with administrator privileges"
        var error: NSDictionary?
        if NSAppleScript(source: source)?.executeAndReturnError(&error) != nil {
            NSApp.terminate(nil)
            return
        }
        // Cancelled at the password dialog (error -128) or failed: put things
        // back the way they were.
        let code = (error?[NSAppleScript.errorNumber] as? Int) ?? 0
        if let path = receiverCandidates().first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            launchReceiver(path: path, fresh: false)
        }
        if code != -128 {
            let message = (error?[NSAppleScript.errorMessage] as? String) ?? "unknown error"
            let alert = NSAlert()
            alert.alertStyle = .critical
            alert.messageText = L("uninstall_failed")
            alert.informativeText = "\(message)\n\n" + L("also_run", ["path": script])
            alert.runModal()
        }
    }

    private func fail(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Remote Visio"
        alert.informativeText = message
        alert.runModal()
        NSApp.terminate(nil)
    }
}

extension AppDelegate: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.addItem(NSMenuItem(title: L("running"), action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        let ips = localIPv4Addresses()
        if ips.isEmpty {
            menu.addItem(NSMenuItem(title: L("no_addr"), action: nil, keyEquivalent: ""))
        } else {
            menu.addItem(NSMenuItem(title: L("endpoint"), action: nil, keyEquivalent: ""))
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
        let mute = NSMenuItem(title: L("mute"), action: #selector(toggleSpeakerMute), keyEquivalent: "")
        mute.target = self
        mute.state = UserDefaults.standard.bool(forKey: speakerMuteKey) ? .on : .off
        menu.addItem(mute)
        if #available(macOS 13.0, *) {
            let login = NSMenuItem(title: L("login"), action: #selector(toggleLoginItem), keyEquivalent: "")
            login.target = self
            login.state = SMAppService.mainApp.status == .enabled ? .on : .off
            menu.addItem(login)
        }
        let uninstallItem = NSMenuItem(title: L("uninstall"), action: #selector(uninstall), keyEquivalent: "")
        uninstallItem.target = self
        menu.addItem(uninstallItem)
        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: L("quit"), action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
    }
}

// The uninstaller calls this so the login item does not linger after the
// app is deleted.
if CommandLine.arguments.contains("--unregister-login-item") {
    if #available(macOS 13.0, *) {
        try? SMAppService.mainApp.unregister()
    }
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
