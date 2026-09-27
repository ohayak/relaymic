import AppKit
import ServiceManagement
import SystemExtensions

// Menu-bar wrapper for remotevisio-receiver: shows the app icon in the status
// bar while the receiver runs, lists the current endpoints (click to copy),
// offers a start-at-login toggle, and quits the receiver cleanly from the
// menu. When this build carries the virtual camera (a system extension,
// see macos/assemble-app.sh) it activates the extension at launch and shows
// its state in the menu.

// Remembers that the user switched start-at-login off, so a later launch
// does not quietly switch it back on.
private let loginItemOptOutKey = "loginItemOptOut"
// When on, the receiver is started with -speaker-mute: the Mac's own
// speakers stay silent while its sound is relayed to the sender.
private let speakerMuteKey = "speakerMute"
// When on, the receiver is started with -camera=false: the remote device's
// camera is not relayed into the virtual camera. Off by default (relay on).
private let cameraOffKey = "cameraOff"

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
        "uninstall_info": "This removes the Remote Visio audio device, the virtual camera, the app and its login item. You will be asked for your administrator password. Sound pauses for about a second while the audio system restarts.",
        "uninstall_btn": "Uninstall",
        "cancel": "Cancel",
        "uninstall_failed": "Uninstall failed",
        "also_run": "You can also run {path} from Terminal.",
        "missing_script": "The uninstall script is missing from this copy of Remote Visio. Run `make uninstall` in the source tree instead.",
        "receiver_missing": "The receiver is missing from this copy of Remote Visio. Reinstall the app.",
        "exited": "remotevisio-receiver exited unexpectedly (status {n}). See ~/Library/Logs/RemoteVisio.log.",
        "start_failed": "Could not start remotevisio-receiver: {err}",
        "camera_toggle": "Relay the Camera",
        "camera_active": "Camera: active",
        "camera_needs_approval": "Camera: needs approval in System Settings",
        "camera_missing": "Camera: not bundled in this build",
        "camera_failed": "Camera: failed ({err})",
        "camera_policy": "blocked by this Mac's management policy; whoever manages it has to allow the extension",
        "camera_reboot": "Camera: active after the Mac restarts",
        "camera_open_settings": "Open System Settings…",
        "camera_not_installed": "Camera: available once the app is in /Applications",
        "camera_deactivate_failed": "The virtual camera could not be removed ({err}). If System Settings still lists the Remote Visio camera extension after uninstalling, restart the Mac.",
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
        "uninstall_info": "Se eliminarán el dispositivo de audio Remote Visio, la cámara virtual, la app y su elemento de inicio. Se te pedirá la contraseña de administrador. El sonido se detiene un segundo mientras el sistema de audio se reinicia.",
        "uninstall_btn": "Desinstalar",
        "cancel": "Cancelar",
        "uninstall_failed": "La desinstalación falló",
        "also_run": "También puedes ejecutar {path} desde Terminal.",
        "missing_script": "Falta el script de desinstalación en esta copia de Remote Visio. Ejecuta `make uninstall` en el código fuente.",
        "receiver_missing": "Falta el receptor en esta copia de Remote Visio. Reinstala la app.",
        "exited": "remotevisio-receiver terminó inesperadamente (estado {n}). Consulta ~/Library/Logs/RemoteVisio.log.",
        "start_failed": "No se pudo iniciar remotevisio-receiver: {err}",
        "camera_toggle": "Retransmitir la cámara",
        "camera_active": "Cámara: activa",
        "camera_needs_approval": "Cámara: requiere aprobación en Ajustes del Sistema",
        "camera_missing": "Cámara: no incluida en esta compilación",
        "camera_failed": "Cámara: error ({err})",
        "camera_policy": "bloqueada por la política de gestión de este Mac; quien lo administra debe permitir la extensión",
        "camera_reboot": "Cámara: activa cuando el Mac se reinicie",
        "camera_open_settings": "Abrir Ajustes del Sistema…",
        "camera_not_installed": "Cámara: disponible cuando la app esté en /Applications",
        "camera_deactivate_failed": "No se pudo quitar la cámara virtual ({err}). Si Ajustes del Sistema sigue mostrando la extensión de cámara de Remote Visio después de desinstalar, reinicia el Mac.",
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
        "uninstall_info": "Cela supprime le périphérique audio Remote Visio, la caméra virtuelle, l'app et son élément de connexion. Votre mot de passe administrateur sera demandé. Le son est coupé environ une seconde pendant le redémarrage du système audio.",
        "uninstall_btn": "Désinstaller",
        "cancel": "Annuler",
        "uninstall_failed": "Échec de la désinstallation",
        "also_run": "Vous pouvez aussi exécuter {path} dans le Terminal.",
        "missing_script": "Le script de désinstallation manque dans cette copie de Remote Visio. Exécutez `make uninstall` depuis les sources.",
        "receiver_missing": "Le récepteur manque dans cette copie de Remote Visio. Réinstallez l'app.",
        "exited": "remotevisio-receiver s'est arrêté de façon inattendue (état {n}). Voir ~/Library/Logs/RemoteVisio.log.",
        "start_failed": "Impossible de démarrer remotevisio-receiver : {err}",
        "camera_toggle": "Relayer la caméra",
        "camera_active": "Caméra : active",
        "camera_needs_approval": "Caméra : à approuver dans Réglages Système",
        "camera_missing": "Caméra : absente de cette version",
        "camera_failed": "Caméra : échec ({err})",
        "camera_policy": "bloquée par la politique de gestion de ce Mac ; la personne qui l'administre doit autoriser l'extension",
        "camera_reboot": "Caméra : active après le redémarrage du Mac",
        "camera_open_settings": "Ouvrir Réglages Système…",
        "camera_not_installed": "Caméra : disponible une fois l'app dans /Applications",
        "camera_deactivate_failed": "La caméra virtuelle n'a pas pu être retirée ({err}). Si Réglages Système affiche encore l'extension caméra de Remote Visio après la désinstallation, redémarrez le Mac.",
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
        "uninstall_info": "这会删除 Remote Visio 音频设备、虚拟摄像头、这个 App 和它的登录项。系统会要求输入管理员密码。音频系统重启时声音会中断大约一秒。",
        "uninstall_btn": "卸载",
        "cancel": "取消",
        "uninstall_failed": "卸载失败",
        "also_run": "也可以在终端里运行 {path}。",
        "missing_script": "这份 Remote Visio 里缺少卸载脚本。请在源码目录里运行 `make uninstall`。",
        "receiver_missing": "这份 Remote Visio 里缺少接收端。请重新安装这个 App。",
        "exited": "remotevisio-receiver 意外退出（状态 {n}）。见 ~/Library/Logs/RemoteVisio.log。",
        "start_failed": "无法启动 remotevisio-receiver：{err}",
        "camera_toggle": "转发摄像头",
        "camera_active": "摄像头：已启用",
        "camera_needs_approval": "摄像头：需要在「系统设置」里允许",
        "camera_missing": "摄像头：这个版本没有包含",
        "camera_failed": "摄像头：失败（{err}）",
        "camera_policy": "被这台 Mac 的管理策略拦截；需要管理员允许这个扩展",
        "camera_reboot": "摄像头：重启 Mac 后启用",
        "camera_open_settings": "打开系统设置…",
        "camera_not_installed": "摄像头：把 App 放进 /Applications 后可用",
        "camera_deactivate_failed": "无法移除虚拟摄像头（{err}）。卸载后如果「系统设置」里仍列出 Remote Visio 的摄像头扩展，请重启 Mac。",
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
        "uninstall_info": "Das entfernt das Remote Visio-Audiogerät, die virtuelle Kamera, die App und ihr Anmeldeobjekt. Sie werden nach Ihrem Administrator-Passwort gefragt. Der Ton setzt etwa eine Sekunde aus, während das Audiosystem neu startet.",
        "uninstall_btn": "Deinstallieren",
        "cancel": "Abbrechen",
        "uninstall_failed": "Deinstallation fehlgeschlagen",
        "also_run": "Sie können auch {path} im Terminal ausführen.",
        "missing_script": "In dieser Kopie von Remote Visio fehlt das Deinstallationsskript. Führen Sie `make uninstall` im Quellcode aus.",
        "receiver_missing": "In dieser Kopie von Remote Visio fehlt der Empfänger. Installieren Sie die App neu.",
        "exited": "remotevisio-receiver wurde unerwartet beendet (Status {n}). Siehe ~/Library/Logs/RemoteVisio.log.",
        "start_failed": "remotevisio-receiver konnte nicht gestartet werden: {err}",
        "camera_toggle": "Kamera weiterleiten",
        "camera_active": "Kamera: aktiv",
        "camera_needs_approval": "Kamera: in den Systemeinstellungen erlauben",
        "camera_missing": "Kamera: in diesem Build nicht enthalten",
        "camera_failed": "Kamera: fehlgeschlagen ({err})",
        "camera_policy": "von der Verwaltungsrichtlinie dieses Macs blockiert; wer ihn verwaltet, muss die Erweiterung erlauben",
        "camera_reboot": "Kamera: aktiv nach dem Neustart des Macs",
        "camera_open_settings": "Systemeinstellungen öffnen…",
        "camera_not_installed": "Kamera: verfügbar, sobald die App in /Applications liegt",
        "camera_deactivate_failed": "Die virtuelle Kamera konnte nicht entfernt werden ({err}). Wenn die Systemeinstellungen die Kameraerweiterung von Remote Visio nach der Deinstallation noch anzeigen, starten Sie den Mac neu.",
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
        "uninstall_info": "Verranno rimossi il dispositivo audio Remote Visio, la fotocamera virtuale, l'app e il suo elemento di login. Ti verrà chiesta la password di amministratore. L'audio si interrompe per circa un secondo mentre il sistema audio si riavvia.",
        "uninstall_btn": "Disinstalla",
        "cancel": "Annulla",
        "uninstall_failed": "Disinstallazione non riuscita",
        "also_run": "Puoi anche eseguire {path} dal Terminale.",
        "missing_script": "In questa copia di Remote Visio manca lo script di disinstallazione. Esegui `make uninstall` nel codice sorgente.",
        "receiver_missing": "In questa copia di Remote Visio manca il ricevitore. Reinstalla l'app.",
        "exited": "remotevisio-receiver si è chiuso in modo imprevisto (stato {n}). Vedi ~/Library/Logs/RemoteVisio.log.",
        "start_failed": "Impossibile avviare remotevisio-receiver: {err}",
        "camera_toggle": "Inoltra la fotocamera",
        "camera_active": "Fotocamera: attiva",
        "camera_needs_approval": "Fotocamera: da approvare in Impostazioni di Sistema",
        "camera_missing": "Fotocamera: non inclusa in questa build",
        "camera_failed": "Fotocamera: errore ({err})",
        "camera_policy": "bloccata dai criteri di gestione di questo Mac; chi lo amministra deve consentire l'estensione",
        "camera_reboot": "Fotocamera: attiva dopo il riavvio del Mac",
        "camera_open_settings": "Apri Impostazioni di Sistema…",
        "camera_not_installed": "Fotocamera: disponibile quando l'app è in /Applications",
        "camera_deactivate_failed": "Non è stato possibile rimuovere la fotocamera virtuale ({err}). Se dopo la disinstallazione Impostazioni di Sistema elenca ancora l'estensione fotocamera di Remote Visio, riavvia il Mac.",
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
        "uninstall_info": "इससे Remote Visio ऑडियो डिवाइस, वर्चुअल कैमरा, यह ऐप और इसका लॉगिन आइटम हट जाएँगे। आपसे व्यवस्थापक पासवर्ड माँगा जाएगा। ऑडियो सिस्टम के रीस्टार्ट होने के दौरान आवाज़ लगभग एक सेकंड के लिए रुकेगी।",
        "uninstall_btn": "हटाएँ",
        "cancel": "रद्द करें",
        "uninstall_failed": "हटाना विफल रहा",
        "also_run": "आप Terminal से {path} भी चला सकते हैं।",
        "missing_script": "Remote Visio की इस कॉपी में अनइंस्टॉल स्क्रिप्ट नहीं है। सोर्स कोड में `make uninstall` चलाएँ।",
        "receiver_missing": "Remote Visio की इस कॉपी में रिसीवर नहीं है। ऐप को दोबारा इंस्टॉल करें।",
        "exited": "remotevisio-receiver अप्रत्याशित रूप से बंद हो गया (स्थिति {n})। ~/Library/Logs/RemoteVisio.log देखें।",
        "start_failed": "remotevisio-receiver शुरू नहीं हो सका: {err}",
        "camera_toggle": "कैमरा रिले करें",
        "camera_active": "कैमरा: चालू",
        "camera_needs_approval": "कैमरा: System Settings में अनुमति चाहिए",
        "camera_missing": "कैमरा: इस बिल्ड में शामिल नहीं",
        "camera_failed": "कैमरा: विफल ({err})",
        "camera_policy": "इस Mac की प्रबंधन नीति ने रोक दिया; इसके प्रबंधक को एक्सटेंशन की अनुमति देनी होगी",
        "camera_reboot": "कैमरा: Mac रीस्टार्ट होने के बाद चालू",
        "camera_open_settings": "System Settings खोलें…",
        "camera_not_installed": "कैमरा: ऐप /Applications में होने पर उपलब्ध",
        "camera_deactivate_failed": "वर्चुअल कैमरा हटाया नहीं जा सका ({err})। अगर हटाने के बाद भी System Settings में Remote Visio का कैमरा एक्सटेंशन दिखे, तो Mac रीस्टार्ट करें।",
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

// The receiver ships next to this executable: Contents/MacOS in the bundle,
// bin/ for a bare build.
private let receiverPath = Bundle.main.executableURL?.deletingLastPathComponent()
    .appendingPathComponent("remotevisio-receiver").path ?? ""
private let logPath = NSHomeDirectory() + "/Library/Logs/RemoteVisio.log"
// The receiver's built-in default; the wrapper never passes -addr. If the port
// ever becomes configurable, pass it as -addr from this constant so the menu's
// endpoints keep matching what the receiver listens on.
private let receiverPort = 7420

// The virtual camera: a Core Media I/O system extension that
// macos/assemble-app.sh bundles into Developer ID builds that carry the
// provisioning profile (macos/README.md, "Virtual camera"). Its bundle
// identifier is fixed; so is where a system extension has to live.
private let cameraExtensionID = "com.remotevisio.app.camera"
private let cameraExtensionBundled = FileManager.default.fileExists(
    atPath: Bundle.main.bundlePath + "/Contents/Library/SystemExtensions/\(cameraExtensionID).systemextension")
// Where macOS lets the user approve the extension: General > Login Items &
// Extensions > Camera Extensions on macOS 15 and later, Privacy & Security
// before that.
private let cameraSettingsURL: String = {
    if #available(macOS 15.0, *) { return "x-apple.systempreferences:com.apple.LoginItems-Settings.extension" }
    return "x-apple.systempreferences:com.apple.preference.security"
}()

// One activation or deactivation request for the camera extension. macOS
// answers through the delegate on the main queue: needs approval (the user
// has to allow it in System Settings; the final answer follows once they
// do), completed, will complete after a reboot, or failed. The manager
// holds the delegate weakly, so the caller keeps this object until then.
final class CameraExtensionRequest: NSObject, OSSystemExtensionRequestDelegate {
    enum Outcome {
        case completed, willCompleteAfterReboot, needsApproval
        case failed(Error)
    }
    private let report: (Outcome) -> Void

    private init(report: @escaping (Outcome) -> Void) {
        self.report = report
    }

    static func activate(report: @escaping (Outcome) -> Void) -> CameraExtensionRequest {
        let delegate = CameraExtensionRequest(report: report)
        let request = OSSystemExtensionRequest.activationRequest(forExtensionWithIdentifier: cameraExtensionID, queue: .main)
        request.delegate = delegate
        OSSystemExtensionManager.shared.submitRequest(request)
        return delegate
    }

    // Asks for an administrator's authorization.
    static func deactivate(report: @escaping (Outcome) -> Void) -> CameraExtensionRequest {
        let delegate = CameraExtensionRequest(report: report)
        let request = OSSystemExtensionRequest.deactivationRequest(forExtensionWithIdentifier: cameraExtensionID, queue: .main)
        request.delegate = delegate
        OSSystemExtensionManager.shared.submitRequest(request)
        return delegate
    }

    // A new app version brings a new extension version (the Makefile stamps
    // the app's version and build number into it; macOS asks only when one
    // of them differs): always replace what is installed.
    func request(_ request: OSSystemExtensionRequest, actionForReplacingExtension existing: OSSystemExtensionProperties,
                 withExtension ext: OSSystemExtensionProperties) -> OSSystemExtensionRequest.ReplacementAction {
        return .replace
    }

    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        report(.needsApproval)
    }

    func request(_ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
        report(result == .willCompleteAfterReboot ? .willCompleteAfterReboot : .completed)
    }

    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        report(.failed(error))
    }

    // What went wrong, for the menu. macOS's own text for a policy denial
    // ("OSSystemExtensionErrorDomain error 10") says nothing a user can act
    // on; a managed Mac only activates the extensions its administrator
    // lists (sysextd logs "not in the list of allowed extensions").
    static func describe(_ error: Error) -> String {
        if let e = error as? OSSystemExtensionError, e.code == .forbiddenBySystemPolicy {
            return L("camera_policy")
        }
        return error.localizedDescription
    }

    // Turn the main run loop until `done` or `timeout` seconds have passed;
    // the delegate is called on the main queue, so a semaphore would block
    // the very queue that delivers the answer.
    static func wait(timeout: TimeInterval, until done: () -> Bool) -> Bool {
        let deadline = Date(timeIntervalSinceNow: timeout)
        while !done() && Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.25))
        }
        return done()
    }
}

// What the menu says about the camera extension.
private enum CameraState {
    case missing        // not bundled in this build: the menu shows no camera items
    case notInstalled   // bundled, but the app is not in /Applications, where macOS wants it
    case requesting     // activation submitted, no answer yet
    case needsApproval
    case active
    case reboot         // active after the Mac restarts
    case failed(String)
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var receiver: Process?
    private var signalSources: [DispatchSourceSignal] = []
    private var cameraState: CameraState = cameraExtensionBundled ? .requesting : .missing
    private var cameraRequest: CameraExtensionRequest?

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

        guard FileManager.default.isExecutableFile(atPath: receiverPath) else {
            fail(L("receiver_missing"))
            return
        }

        // Before the receiver starts: macOS registers (or replaces) the
        // extension while the rest comes up, and the receiver finds it.
        activateCameraExtensionIfInstalled()

        // Anchor near the right edge so the notch can't swallow the icon: a
        // status item without a remembered position appears leftmost, where
        // macOS hides it on notched Macs when the menu bar is crowded. AppKit
        // keeps the position under this key (points from the right end of the
        // status area); seed it once, and dragging the icon overrides it.
        let autosaveName = "RemoteVisioStatus"
        let positionKey = "NSStatusItem Preferred Position \(autosaveName)"
        if UserDefaults.standard.object(forKey: positionKey) == nil {
            UserDefaults.standard.set(40, forKey: positionKey)
        }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.autosaveName = autosaveName
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
            }
            button.toolTip = L("running_tip")
        }
        let menu = NSMenu()
        menu.delegate = self // rebuilt on every click so endpoints stay current
        item.menu = menu
        statusItem = item

        registerLoginItemIfInstalled()
        launchReceiver(fresh: true)
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
        launchReceiver(fresh: false)
    }

    // Same for -camera.
    @objc private func toggleCameraRelay() {
        let off = !UserDefaults.standard.bool(forKey: cameraOffKey)
        UserDefaults.standard.set(off, forKey: cameraOffKey)
        stopReceiver()
        launchReceiver(fresh: false)
    }

    // Activate the camera extension bundled in this app. macOS only takes
    // one from an app in /Applications (same rule as the login item), and
    // asks the user to approve it the first time; a newer version replaces
    // the installed one. The menu shows how it went.
    private func activateCameraExtensionIfInstalled() {
        guard cameraExtensionBundled else { return }
        guard Bundle.main.bundlePath == "/Applications/RemoteVisio.app" else {
            cameraState = .notInstalled
            return
        }
        cameraState = .requesting
        cameraRequest = CameraExtensionRequest.activate { [weak self] outcome in
            guard let self = self else { return }
            switch outcome {
            case .completed: self.cameraState = .active
            case .willCompleteAfterReboot: self.cameraState = .reboot
            case .needsApproval: self.cameraState = .needsApproval
            case .failed(let error): self.cameraState = .failed(CameraExtensionRequest.describe(error))
            }
        }
    }

    // Deactivate the extension and wait for macOS (it asks for an
    // administrator's authorization), up to `timeout` seconds. Returns nil
    // when it is gone or goes at the next reboot, otherwise what went wrong.
    private func deactivateCameraExtension(timeout: TimeInterval) -> String? {
        guard cameraExtensionBundled else { return nil }
        var outcome: CameraExtensionRequest.Outcome?
        cameraRequest = CameraExtensionRequest.deactivate { outcome = $0 }
        _ = CameraExtensionRequest.wait(timeout: timeout) { outcome != nil }
        switch outcome {
        case .completed?, .willCompleteAfterReboot?: return nil
        case .needsApproval?: return L("camera_needs_approval")
        case .failed(let error)?: return CameraExtensionRequest.describe(error)
        case nil: return "timeout"
        }
    }

    @objc private func openCameraSettings() {
        if let url = URL(string: cameraSettingsURL) {
            NSWorkspace.shared.open(url)
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
    private func launchReceiver(fresh: Bool) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: receiverPath)
        var arguments: [String] = []
        if UserDefaults.standard.bool(forKey: speakerMuteKey) { arguments.append("-speaker-mute") }
        if UserDefaults.standard.bool(forKey: cameraOffKey) { arguments.append("-camera=false") }
        proc.arguments = arguments

        // Finder launches apps with a minimal PATH that excludes user bin dirs;
        // the receiver looks up the tailscale CLI on PATH.
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\(NSHomeDirectory())/.local/bin:/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        proc.environment = env

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
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.launchReceiver(fresh: false) }
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

    // Menu-driven uninstall: confirm, drop the login item, deactivate the
    // camera extension (macOS asks for the admin password; the app has to
    // still exist for that, so it comes first), stop the receiver, then run
    // the bundled uninstall script as root through the standard macOS
    // password dialog. It removes the audio device driver, restarts
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
        // A failure here does not stop the uninstall; the user hears about
        // it at the end, with what to do (a reboot clears it).
        let cameraProblem = deactivateCameraExtension(timeout: 60)
        stopReceiver()

        // Paths come from the bundle; quote them for the shell all the same.
        let quoted = "'" + script.replacingOccurrences(of: "'", with: "'\\''") + "'"
        let source = "do shell script \"\(quoted) --from-app\" with administrator privileges"
        var error: NSDictionary?
        if NSAppleScript(source: source)?.executeAndReturnError(&error) != nil {
            if let problem = cameraProblem {
                let note = NSAlert()
                note.alertStyle = .warning
                note.messageText = "Remote Visio"
                note.informativeText = L("camera_deactivate_failed", ["err": problem])
                note.runModal()
            }
            NSApp.terminate(nil)
            return
        }
        // Cancelled at the password dialog (error -128) or failed: put things
        // back the way they were, the camera extension included.
        let code = (error?[NSAppleScript.errorNumber] as? Int) ?? 0
        activateCameraExtensionIfInstalled()
        launchReceiver(fresh: false)
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
        addCameraStatus(to: menu)
        menu.addItem(.separator())
        let ips = localIPv4Addresses()
        if ips.isEmpty {
            menu.addItem(NSMenuItem(title: L("no_addr"), action: nil, keyEquivalent: ""))
        } else {
            menu.addItem(NSMenuItem(title: L("endpoint"), action: nil, keyEquivalent: ""))
            for ip in ips {
                let url = "https://\(ip):\(receiverPort)"
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
        if cameraExtensionBundled {
            let camera = NSMenuItem(title: L("camera_toggle"), action: #selector(toggleCameraRelay), keyEquivalent: "")
            camera.target = self
            camera.state = UserDefaults.standard.bool(forKey: cameraOffKey) ? .off : .on
            menu.addItem(camera)
        }
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

    // The camera line under the receiver line: nothing when this build has no
    // extension, nothing yet while macOS is still answering, otherwise the
    // state. Waiting for approval, the line (and an entry under it) opens
    // System Settings where the user allows it.
    private func addCameraStatus(to menu: NSMenu) {
        let title: String
        switch cameraState {
        case .missing, .requesting: return
        case .notInstalled: title = L("camera_not_installed")
        case .active: title = L("camera_active")
        case .reboot: title = L("camera_reboot")
        case .failed(let err): title = L("camera_failed", ["err": err])
        case .needsApproval:
            let line = NSMenuItem(title: L("camera_needs_approval"), action: #selector(openCameraSettings), keyEquivalent: "")
            line.target = self
            menu.addItem(line)
            let open = NSMenuItem(title: L("camera_open_settings"), action: #selector(openCameraSettings), keyEquivalent: "")
            open.target = self
            open.indentationLevel = 1
            menu.addItem(open)
            return
        }
        menu.addItem(NSMenuItem(title: title, action: nil, keyEquivalent: ""))
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

// The uninstaller's Terminal path calls this, as the user at the console,
// before it deletes the app: deactivate the camera extension (macOS asks
// for an administrator's authorization) and exit once macOS has answered.
// Best effort: the uninstall goes on either way, and a reboot clears an
// extension whose app is gone. Status 0 when it is gone or goes at the next
// reboot, 1 otherwise, with the reason on stderr.
if CommandLine.arguments.contains("--deactivate-camera") {
    guard cameraExtensionBundled else { exit(0) }
    var outcome: CameraExtensionRequest.Outcome?
    let request = CameraExtensionRequest.deactivate { outcome = $0 }
    _ = CameraExtensionRequest.wait(timeout: 60) { outcome != nil }
    withExtendedLifetime(request) {}
    let problem: String?
    switch outcome {
    case .completed?, .willCompleteAfterReboot?: problem = nil
    case .needsApproval?: problem = "needs approval in System Settings"
    case .failed(let error)?: problem = error.localizedDescription
    case nil: problem = "no answer from macOS within 60 s"
    }
    if let problem = problem {
        FileHandle.standardError.write("could not deactivate \(cameraExtensionID): \(problem)\n".data(using: .utf8)!)
        exit(1)
    }
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
