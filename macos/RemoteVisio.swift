import AppKit
import ServiceManagement
import SystemExtensions

// Menu-bar wrapper for remotevisio-receiver: shows the app icon in the status
// bar while the receiver runs, lists the current endpoints (click to copy),
// offers a start-at-login toggle, and quits the receiver cleanly from the
// menu. When this build carries the virtual camera (a system extension,
// see macos/assemble-app.sh) it activates the extension at launch and shows
// its state in the menu. The browser camera (the Remote Visio Camera
// browser extension, for Macs where the system extension cannot be
// activated) is set up from the menu, on the user's request only.

// Remembers that the user switched start-at-login off, so a later launch
// does not quietly switch it back on.
private let loginItemOptOutKey = "loginItemOptOut"
// When on, the receiver is started with -speaker-mute: the Mac's own
// speakers stay silent while its sound is relayed to the sender.
private let speakerMuteKey = "speakerMute"
// When on, the receiver is started with -mic-mute: this Mac's own
// microphones are muted while it runs, so apps hear only the remote voice.
// The receiver writes their settings down first and puts them back when it
// stops (or, after a crash, when it next starts).
private let micMuteKey = "micMute"
// When on, the receiver is started with -camera=false: the remote device's
// camera is not relayed into the virtual camera. Off by default (relay on).
// It is the master switch for the browser camera too.
private let cameraOffKey = "cameraOff"
// When on, and the camera relay is not switched off, the receiver is
// started with -browser-camera: the remote camera also goes to the Remote
// Visio Camera browser extension. The install flow switches it on.
private let browserCameraKey = "browserCamera"
// Set once the browser camera's install flow has succeeded: from then on the
// menu shows the Browser Camera switch, and every launch refreshes the
// extension's installed copy from this app (browser-extension.sh sync).
private let browserCameraInstalledKey = "browserCameraInstalled"
// How the browser camera was installed: "store" (from its Chrome Web Store
// page) or "unpacked" (a copy in the user's Application Support, loaded in
// Developer mode). Missing for installs from before the store listing,
// which were all unpacked. Only an unpacked copy has files this app keeps up
// to date and can find gone.
private let browserCameraModeKey = "browserCameraMode"

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
        "mic_mute": "Mute This Mac's Microphone",
        "uninstall_q": "Uninstall Remote Visio?",
        "uninstall_info": "This removes the Remote Visio audio device, the virtual camera, the app and its login item. You will be asked for your administrator password. Sound pauses for about a second while the audio system restarts. If you installed the browser camera, also remove \"Remote Visio Camera\" on your browser's extensions page.",
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
        "bcam_toggle": "Browser Camera",
        "bcam_install": "Install Browser Camera Extension…",
        "bcam_reinstall": "Reinstall Browser Camera Extension…",
        "bcam_done_title": "Almost done: add the extension to {browser}",
        "bcam_done_steps": "1. In {browser}, on the extensions page that just opened ({url}), turn on \"Developer mode\" ({where}) and leave it on: the browser switches the extension off without it.\n\n2. Click \"Load unpacked\" and choose the folder \"Browser Camera Extension\": Finder shows it, and its path is on the clipboard (press Command-Shift-G in the dialog, then paste). Or drag that folder onto the extensions page.\n\n3. Pin the extension: click the Extensions button (the puzzle piece) in the toolbar, then the pin next to \"Remote Visio Camera\" (the eye in Edge). Its button then stays in the toolbar.\n\n4. On your meeting's website, choose \"Remote Visio Camera\" as the camera, and click Allow when asked. Reload meeting pages that were already open.",
        "bcam_devmode_topright": "top right",
        "bcam_devmode_left": "in the left column",
        "bcam_done_edge": "At every start, Edge offers to turn off extensions in developer mode. Do not accept, or the camera disappears.",
        "bcam_done_profiles": "The extension and Developer mode belong to one browser profile, and the extensions page opened in the profile you used last. Load the extension in each profile you use for meetings. It works in Chrome, Edge, Brave, Arc and other Chromium browsers.",
        "bcam_not_chromium_title": "{browser} cannot use the Remote Visio Camera extension",
        "bcam_not_chromium": "It works in Chromium browsers. Install it in:",
        "bcam_no_chromium_title": "No Chromium browser on this Mac",
        "bcam_no_chromium": "The Remote Visio Camera extension works only in Chromium browsers, such as Chrome, Edge, Brave or Arc, and {browser} is not one of them. Install one of those browsers, then choose \"Install Browser Camera Extension…\" again.",
        "bcam_failed": "The browser camera extension could not be installed",
        "bcam_policy_title": "{browser} does not allow this extension",
        "bcam_policy": "{browser} is managed by your organization, and its policy does not let you load extensions this way. Ask your IT department to allow the extension with the ID {id} and Developer mode.",
        "bcam_policy_devmode": "{browser} is managed by your organization, and its policy turns off Developer mode, which this extension needs. Ask your IT department to set the ExtensionDeveloperModeSettings policy to 0 (allow); that is enough, DeveloperToolsAvailability can stay as it is.",
        "bcam_policy_blocklist": "{browser} is managed by your organization, and its policy blocks this extension. Ask your IT department to take the extension ID {id} off the blocklist (ExtensionInstallBlocklist, or its entry in ExtensionSettings).",
        "bcam_policy_blocklist_all": "{browser} is managed by your organization, and its policy blocks all extensions by default (\"*\"). Allowing this extension's ID does not help: while that block is on, the browser loads no unpacked extension (one loaded from a folder, like this one). Ask your IT department to lift the block (\"*\" in ExtensionInstallBlocklist or ExtensionSettings, or CloudExtensionRequestEnabled).",
        "bcam_policy_types": "{browser} is managed by your organization, and its policy allows only some types of extensions. Ask your IT department to add \"extension\" to the allowed types (ExtensionAllowedTypes, or allowed_types in ExtensionSettings).",
        "bcam_policy_other": "Or install it in another browser:",
        "bcam_missing": "The browser camera extension is missing from this copy of Remote Visio. Reinstall the app.",
        "bcam_store_remove_unpacked": "Remote Visio Camera is also loaded unpacked in this browser (from before). Once the store's copy is added, remove the old one on the extensions page (the card with the ID jmiffhdbakchdlfbfdiaclkilcdhcgkf), or the camera is listed twice.",
        "bcam_unpacked_remove_store": "If you added Remote Visio Camera from the Chrome Web Store before, remove that copy on the extensions page (the card with the ID bhijcffjnmjijifjiaeibbogmbohdmon), or the camera is listed twice.",
        "bcam_store_steps": "1. In {browser}, on the Chrome Web Store page that just opened, click \"Add to Chrome\" (\"Get\" in Edge), then \"Add extension\".\n\n2. Pin the extension: click the Extensions button (the puzzle piece) in the toolbar, then the pin next to \"Remote Visio Camera\" (the eye in Edge). Its button then stays in the toolbar.\n\n3. On your meeting's website, choose \"Remote Visio Camera\" as the camera, and click Allow when asked. Reload meeting pages that were already open.",
        "bcam_store_edge": "Edge may first ask you to allow extensions from other stores. Allow it, then click \"Get\".",
        "bcam_store_profiles": "The extension belongs to one browser profile, and the store page opened in the profile you used last. Add it in each profile you use for meetings. If the store page does not work, choose \"Load Unpacked Instead…\" (it needs Developer mode).",
        "bcam_unpacked_button": "Load Unpacked Instead…",
        "ok": "OK",
        "bcam_policy_blocklist_all_store": "{browser} is managed by your organization, and its policy blocks all extensions by default (\"*\"). Ask your IT department to allow the extension ID {id} (ExtensionInstallAllowlist, or an entry for it in ExtensionSettings).",
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
        "mic_mute": "Silenciar el micrófono de este Mac",
        "uninstall_q": "¿Desinstalar Remote Visio?",
        "uninstall_info": "Se eliminarán el dispositivo de audio Remote Visio, la cámara virtual, la app y su elemento de inicio. Se te pedirá la contraseña de administrador. El sonido se detiene un segundo mientras el sistema de audio se reinicia. Si instalaste la cámara del navegador, quita también «Remote Visio Camera» en la página de extensiones de tu navegador.",
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
        "bcam_toggle": "Cámara del navegador",
        "bcam_install": "Instalar la extensión de cámara del navegador…",
        "bcam_reinstall": "Reinstalar la extensión de cámara del navegador…",
        "bcam_done_title": "Casi listo: añade la extensión a {browser}",
        "bcam_done_steps": "1. En {browser}, en la página de extensiones que se acaba de abrir ({url}), activa «Modo Desarrollador» ({where}) y déjalo activado: sin él, el navegador desactiva la extensión.\n\n2. Haz clic en «Cargar descomprimida» y elige la carpeta «Browser Camera Extension»: el Finder la muestra y su ruta está en el portapapeles (pulsa Comando-Mayúsculas-G en el cuadro de diálogo y pégala). También puedes arrastrar esa carpeta a la página de extensiones.\n\n3. Fija la extensión: haz clic en el botón Extensiones (la pieza de puzle) de la barra de herramientas y luego en la chincheta junto a «Remote Visio Camera» (el ojo en Edge). Así su botón se queda en la barra de herramientas.\n\n4. En la web de tu reunión, elige «Remote Visio Camera» como cámara y haz clic en Permitir cuando se te pregunte. Vuelve a cargar las páginas de reunión que ya estaban abiertas.",
        "bcam_devmode_topright": "arriba a la derecha",
        "bcam_devmode_left": "en la columna de la izquierda",
        "bcam_done_edge": "Cada vez que se inicia, Edge ofrece desactivar las extensiones en modo desarrollador. No aceptes, o la cámara desaparecerá.",
        "bcam_done_profiles": "La extensión y el modo desarrollador pertenecen a un solo perfil del navegador, y la página de extensiones se abrió en el último perfil que usaste. Carga la extensión en cada perfil que uses para reuniones. Funciona en Chrome, Edge, Brave, Arc y otros navegadores Chromium.",
        "bcam_not_chromium_title": "{browser} no puede usar la extensión Remote Visio Camera",
        "bcam_not_chromium": "Funciona en navegadores Chromium. Instálala en:",
        "bcam_no_chromium_title": "No hay ningún navegador Chromium en este Mac",
        "bcam_no_chromium": "La extensión Remote Visio Camera solo funciona en navegadores Chromium, como Chrome, Edge, Brave o Arc, y {browser} no es uno de ellos. Instala uno de esos navegadores y vuelve a elegir «Instalar la extensión de cámara del navegador…».",
        "bcam_failed": "No se pudo instalar la extensión de cámara del navegador",
        "bcam_policy_title": "{browser} no permite esta extensión",
        "bcam_policy": "{browser} está administrado por tu organización y su política no te deja cargar extensiones de esta forma. Pide a tu departamento de TI que permita la extensión con el ID {id} y el modo desarrollador.",
        "bcam_policy_devmode": "{browser} está administrado por tu organización y su política desactiva el modo desarrollador, que esta extensión necesita. Pide a tu departamento de TI que ponga la política ExtensionDeveloperModeSettings en 0 (permitir); con eso basta, DeveloperToolsAvailability puede quedarse como está.",
        "bcam_policy_blocklist": "{browser} está administrado por tu organización y su política bloquea esta extensión. Pide a tu departamento de TI que quite el ID de extensión {id} de la lista de bloqueo (ExtensionInstallBlocklist, o su entrada en ExtensionSettings).",
        "bcam_policy_blocklist_all": "{browser} está administrado por tu organización y su política bloquea todas las extensiones por defecto («*»). Permitir el ID de esta extensión no sirve: mientras ese bloqueo siga activo, el navegador no carga ninguna extensión descomprimida (cargada desde una carpeta, como esta). Pide a tu departamento de TI que quite el bloqueo («*» en ExtensionInstallBlocklist o ExtensionSettings, o CloudExtensionRequestEnabled).",
        "bcam_policy_types": "{browser} está administrado por tu organización y su política solo permite algunos tipos de extensiones. Pide a tu departamento de TI que añada «extension» a los tipos permitidos (ExtensionAllowedTypes, o allowed_types en ExtensionSettings).",
        "bcam_policy_other": "O instálala en otro navegador:",
        "bcam_missing": "Falta la extensión de cámara del navegador en esta copia de Remote Visio. Reinstala la app.",
        "bcam_store_remove_unpacked": "Remote Visio Camera también está cargada descomprimida en este navegador (de antes). Cuando hayas añadido la copia de la tienda, quita la antigua en la página de extensiones (la tarjeta con el ID jmiffhdbakchdlfbfdiaclkilcdhcgkf); si no, la cámara aparece dos veces.",
        "bcam_unpacked_remove_store": "Si antes añadiste Remote Visio Camera desde Chrome Web Store, quita esa copia en la página de extensiones (la tarjeta con el ID bhijcffjnmjijifjiaeibbogmbohdmon); si no, la cámara aparece dos veces.",
        "bcam_store_steps": "1. En {browser}, en la página de Chrome Web Store que se acaba de abrir, haz clic en «Añadir a Chrome» («Obtener» en Edge) y luego en «Añadir extensión».\n\n2. Fija la extensión: haz clic en el botón Extensiones (la pieza de puzle) de la barra de herramientas y luego en la chincheta junto a «Remote Visio Camera» (el ojo en Edge). Así su botón se queda en la barra de herramientas.\n\n3. En la web de tu reunión, elige «Remote Visio Camera» como cámara y haz clic en Permitir cuando se te pregunte. Vuelve a cargar las páginas de reunión que ya estaban abiertas.",
        "bcam_store_edge": "Puede que Edge te pida primero permitir extensiones de otras tiendas. Permítelo y luego haz clic en «Obtener».",
        "bcam_store_profiles": "La extensión pertenece a un solo perfil del navegador, y la página de la tienda se abrió en el último perfil que usaste. Añádela en cada perfil que uses para reuniones. Si la página de la tienda no funciona, elige «Cargar descomprimida en su lugar…» (necesita el modo desarrollador).",
        "bcam_unpacked_button": "Cargar descomprimida en su lugar…",
        "ok": "Aceptar",
        "bcam_policy_blocklist_all_store": "{browser} está administrado por tu organización, y su política bloquea todas las extensiones de forma predeterminada («*»). Pide a tu departamento de TI que permita el ID de extensión {id} (ExtensionInstallAllowlist, o una entrada para él en ExtensionSettings).",
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
        "mic_mute": "Couper le micro de ce Mac",
        "uninstall_q": "Désinstaller Remote Visio ?",
        "uninstall_info": "Cela supprime le périphérique audio Remote Visio, la caméra virtuelle, l'app et son élément de connexion. Votre mot de passe administrateur sera demandé. Le son est coupé environ une seconde pendant le redémarrage du système audio. Si vous avez installé la caméra du navigateur, retirez aussi « Remote Visio Camera » de la page des extensions de votre navigateur.",
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
        "bcam_toggle": "Caméra du navigateur",
        "bcam_install": "Installer l'extension Caméra du navigateur…",
        "bcam_reinstall": "Réinstaller l'extension Caméra du navigateur…",
        "bcam_done_title": "Presque fini : ajoutez l'extension à {browser}",
        "bcam_done_steps": "1. Dans {browser}, sur la page des extensions qui vient de s'ouvrir ({url}), activez « Mode développeur » ({where}) et laissez-le activé : sans lui, le navigateur désactive l'extension.\n\n2. Cliquez sur « Charger l'extension non empaquetée » et choisissez le dossier « Browser Camera Extension » : le Finder l'affiche, et son chemin est dans le presse-papiers (appuyez sur Commande-Maj-G dans la fenêtre de sélection, puis collez). Vous pouvez aussi faire glisser ce dossier sur la page des extensions.\n\n3. Épinglez l'extension : cliquez sur le bouton Extensions (la pièce de puzzle) dans la barre d'outils, puis sur l'épingle à côté de « Remote Visio Camera » (l'œil dans Edge). Son bouton reste alors dans la barre d'outils.\n\n4. Sur le site de votre réunion, choisissez « Remote Visio Camera » comme caméra, puis cliquez sur Autoriser quand c'est demandé. Rechargez les pages de réunion déjà ouvertes.",
        "bcam_devmode_topright": "en haut à droite",
        "bcam_devmode_left": "dans la colonne de gauche",
        "bcam_done_edge": "À chaque démarrage, Edge propose de désactiver les extensions en mode développeur. Refusez, sinon la caméra disparaît.",
        "bcam_done_profiles": "L'extension et le mode développeur appartiennent à un seul profil du navigateur, et la page des extensions s'est ouverte dans le dernier profil utilisé. Chargez l'extension dans chaque profil qui vous sert pour les réunions. Elle fonctionne dans Chrome, Edge, Brave, Arc et les autres navigateurs Chromium.",
        "bcam_not_chromium_title": "{browser} ne peut pas utiliser l'extension Remote Visio Camera",
        "bcam_not_chromium": "Elle fonctionne dans les navigateurs Chromium. L'installer dans :",
        "bcam_no_chromium_title": "Aucun navigateur Chromium sur ce Mac",
        "bcam_no_chromium": "L'extension Remote Visio Camera ne fonctionne que dans les navigateurs Chromium, comme Chrome, Edge, Brave ou Arc, et {browser} n'en fait pas partie. Installez l'un de ces navigateurs, puis choisissez à nouveau « Installer l'extension Caméra du navigateur… ».",
        "bcam_failed": "L'extension Caméra du navigateur n'a pas pu être installée",
        "bcam_policy_title": "{browser} n'autorise pas cette extension",
        "bcam_policy": "{browser} est géré par votre organisation, et sa politique ne vous permet pas de charger des extensions de cette façon. Demandez à votre service informatique d'autoriser l'extension dont l'ID est {id} ainsi que le mode développeur.",
        "bcam_policy_devmode": "{browser} est géré par votre organisation, et sa politique désactive le mode développeur, dont cette extension a besoin. Demandez à votre service informatique de mettre la règle ExtensionDeveloperModeSettings à 0 (autoriser) ; cela suffit, DeveloperToolsAvailability peut rester tel quel.",
        "bcam_policy_blocklist": "{browser} est géré par votre organisation, et sa politique bloque cette extension. Demandez à votre service informatique de retirer l'ID d'extension {id} de la liste de blocage (ExtensionInstallBlocklist, ou son entrée dans ExtensionSettings).",
        "bcam_policy_blocklist_all": "{browser} est géré par votre organisation, et sa politique bloque toutes les extensions par défaut (« * »). Autoriser l'ID de cette extension n'y change rien : tant que ce blocage est actif, le navigateur ne charge aucune extension non empaquetée (chargée depuis un dossier, comme celle-ci). Demandez à votre service informatique de lever ce blocage (« * » dans ExtensionInstallBlocklist ou ExtensionSettings, ou CloudExtensionRequestEnabled).",
        "bcam_policy_types": "{browser} est géré par votre organisation, et sa politique n'autorise que certains types d'extensions. Demandez à votre service informatique d'ajouter « extension » aux types autorisés (ExtensionAllowedTypes, ou allowed_types dans ExtensionSettings).",
        "bcam_policy_other": "Ou installez-la dans un autre navigateur :",
        "bcam_missing": "L'extension Caméra du navigateur manque dans cette copie de Remote Visio. Réinstallez l'app.",
        "bcam_store_remove_unpacked": "Remote Visio Camera est aussi chargée non empaquetée dans ce navigateur (depuis avant). Une fois la copie de la boutique ajoutée, retirez l'ancienne sur la page des extensions (la carte avec l'ID jmiffhdbakchdlfbfdiaclkilcdhcgkf), sinon la caméra apparaît deux fois.",
        "bcam_unpacked_remove_store": "Si vous aviez ajouté Remote Visio Camera depuis le Chrome Web Store, retirez cette copie sur la page des extensions (la carte avec l'ID bhijcffjnmjijifjiaeibbogmbohdmon), sinon la caméra apparaît deux fois.",
        "bcam_store_steps": "1. Dans {browser}, sur la page du Chrome Web Store qui vient de s'ouvrir, cliquez sur « Ajouter à Chrome » (« Obtenir » dans Edge), puis sur « Ajouter l'extension ».\n\n2. Épinglez l'extension : cliquez sur le bouton Extensions (la pièce de puzzle) dans la barre d'outils, puis sur l'épingle à côté de « Remote Visio Camera » (l'œil dans Edge). Son bouton reste alors dans la barre d'outils.\n\n3. Sur le site de votre réunion, choisissez « Remote Visio Camera » comme caméra, puis cliquez sur Autoriser quand c'est demandé. Rechargez les pages de réunion déjà ouvertes.",
        "bcam_store_edge": "Edge peut d'abord vous demander d'autoriser les extensions d'autres boutiques. Autorisez-les, puis cliquez sur « Obtenir ».",
        "bcam_store_profiles": "L'extension appartient à un seul profil du navigateur, et la page de la boutique s'est ouverte dans le dernier profil utilisé. Ajoutez-la dans chaque profil qui vous sert pour les réunions. Si la page de la boutique ne fonctionne pas, choisissez « Charger non empaquetée à la place… » (il faut le mode développeur).",
        "bcam_unpacked_button": "Charger non empaquetée à la place…",
        "ok": "OK",
        "bcam_policy_blocklist_all_store": "{browser} est géré par votre organisation, et sa politique bloque toutes les extensions par défaut (« * »). Demandez à votre service informatique d'autoriser l'ID d'extension {id} (ExtensionInstallAllowlist, ou une entrée pour lui dans ExtensionSettings).",
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
        "mic_mute": "静音这台 Mac 的麦克风",
        "uninstall_q": "要卸载 Remote Visio 吗？",
        "uninstall_info": "这会删除 Remote Visio 音频设备、虚拟摄像头、这个 App 和它的登录项。系统会要求输入管理员密码。音频系统重启时声音会中断大约一秒。如果安装过浏览器摄像头，也请在浏览器的扩展程序页面里移除「Remote Visio Camera」。",
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
        "bcam_toggle": "浏览器摄像头",
        "bcam_install": "安装浏览器摄像头扩展…",
        "bcam_reinstall": "重新安装浏览器摄像头扩展…",
        "bcam_done_title": "快完成了：把扩展添加到 {browser}",
        "bcam_done_steps": "1. 在 {browser} 刚打开的扩展程序页面（{url}）上，打开{where}的「开发者模式」，并保持打开：关掉后浏览器会停用这个扩展。\n\n2. 点击「加载未打包的扩展程序」，选择「Browser Camera Extension」文件夹：访达已经显示了它，它的路径也已复制到剪贴板（在对话框里按 Command-Shift-G，然后粘贴）。也可以把这个文件夹直接拖到扩展程序页面上。\n\n3. 固定这个扩展：点击工具栏里的「扩展程序」按钮（拼图图标），再点击「Remote Visio Camera」旁边的图钉（在 Edge 里是眼睛图标）。这样它的按钮就会一直留在工具栏上。\n\n4. 在会议网站上把摄像头选为「Remote Visio Camera」，询问时点击「允许」。已经打开的会议页面需要重新加载。",
        "bcam_devmode_topright": "右上角",
        "bcam_devmode_left": "左侧栏中",
        "bcam_done_edge": "Edge 每次启动时都会提议关闭开发者模式下的扩展。不要接受，否则摄像头会消失。",
        "bcam_done_profiles": "扩展和开发者模式只属于一个浏览器个人资料，刚才的扩展程序页面是在你上次使用的个人资料里打开的。请在每个用来开会的个人资料里都加载这个扩展。它适用于 Chrome、Edge、Brave、Arc 和其他 Chromium 浏览器。",
        "bcam_not_chromium_title": "{browser} 无法使用 Remote Visio Camera 扩展",
        "bcam_not_chromium": "它适用于 Chromium 浏览器。安装到：",
        "bcam_no_chromium_title": "这台 Mac 上没有 Chromium 浏览器",
        "bcam_no_chromium": "Remote Visio Camera 扩展只能在 Chromium 浏览器（例如 Chrome、Edge、Brave 或 Arc）中使用，而 {browser} 不是。请先安装其中一个浏览器，然后再次选择「安装浏览器摄像头扩展…」。",
        "bcam_failed": "无法安装浏览器摄像头扩展",
        "bcam_policy_title": "{browser} 不允许这个扩展",
        "bcam_policy": "{browser} 由你所在的机构管理，它的策略不允许用这种方式加载扩展。请让 IT 部门允许 ID 为 {id} 的扩展以及开发者模式。",
        "bcam_policy_devmode": "{browser} 由你所在的机构管理，它的策略关闭了这个扩展需要的开发者模式。请让 IT 部门把 ExtensionDeveloperModeSettings 策略设为 0（允许）；这样就够了，DeveloperToolsAvailability 可以保持不变。",
        "bcam_policy_blocklist": "{browser} 由你所在的机构管理，它的策略拦截了这个扩展。请让 IT 部门把扩展 ID {id} 从阻止列表中移除（ExtensionInstallBlocklist，或 ExtensionSettings 中它的条目）。",
        "bcam_policy_blocklist_all": "{browser} 由你所在的机构管理，它的策略默认拦截所有扩展（「*」）。允许这个扩展的 ID 没有用：只要这个拦截还在，浏览器就不会加载任何未打包的扩展（像这个扩展一样从文件夹加载的扩展）。请让 IT 部门取消这个拦截（ExtensionInstallBlocklist 或 ExtensionSettings 中的「*」，或 CloudExtensionRequestEnabled）。",
        "bcam_policy_types": "{browser} 由你所在的机构管理，它的策略只允许某些类型的扩展。请让 IT 部门把「extension」加到允许的类型里（ExtensionAllowedTypes，或 ExtensionSettings 中的 allowed_types）。",
        "bcam_policy_other": "或者把它装到另一个浏览器里：",
        "bcam_missing": "这份 Remote Visio 里缺少浏览器摄像头扩展。请重新安装这个 App。",
        "bcam_store_remove_unpacked": "这个浏览器里还有以前以未打包方式加载的 Remote Visio Camera。添加商店版之后，请在扩展程序页面上移除旧的那个（ID 为 jmiffhdbakchdlfbfdiaclkilcdhcgkf 的卡片），否则摄像头会出现两次。",
        "bcam_unpacked_remove_store": "如果你以前从 Chrome 应用商店添加过 Remote Visio Camera，请在扩展程序页面上移除那一份（ID 为 bhijcffjnmjijifjiaeibbogmbohdmon 的卡片），否则摄像头会出现两次。",
        "bcam_store_steps": "1. 在 {browser} 刚打开的 Chrome 应用商店页面上，点击「添加至 Chrome」（在 Edge 里是「获取」），然后点击「添加扩展程序」。\n\n2. 固定这个扩展：点击工具栏里的「扩展程序」按钮（拼图图标），再点击「Remote Visio Camera」旁边的图钉（在 Edge 里是眼睛图标）。这样它的按钮就会一直留在工具栏上。\n\n3. 在会议网站上把摄像头选为「Remote Visio Camera」，询问时点击「允许」。已经打开的会议页面需要重新加载。",
        "bcam_store_edge": "Edge 可能会先请你允许来自其他应用商店的扩展。请允许，然后点击「获取」。",
        "bcam_store_profiles": "扩展只属于一个浏览器个人资料，刚才的商店页面是在你上次使用的个人资料里打开的。请在每个用来开会的个人资料里都添加它。如果商店页面用不了，请选「改为加载未打包的扩展…」（需要开发者模式）。",
        "bcam_unpacked_button": "改为加载未打包的扩展…",
        "ok": "好",
        "bcam_policy_blocklist_all_store": "{browser} 由你所在的机构管理，它的策略默认阻止所有扩展（「*」）。请让 IT 部门允许扩展 ID {id}（ExtensionInstallAllowlist，或在 ExtensionSettings 里为它加一项）。",
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
        "mic_mute": "Mikrofon dieses Macs stummschalten",
        "uninstall_q": "Remote Visio deinstallieren?",
        "uninstall_info": "Das entfernt das Remote Visio-Audiogerät, die virtuelle Kamera, die App und ihr Anmeldeobjekt. Sie werden nach Ihrem Administrator-Passwort gefragt. Der Ton setzt etwa eine Sekunde aus, während das Audiosystem neu startet. Wenn Sie die Browser-Kamera installiert haben, entfernen Sie „Remote Visio Camera“ auch auf der Erweiterungsseite Ihres Browsers.",
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
        "bcam_toggle": "Browser-Kamera",
        "bcam_install": "Browser-Kamera-Erweiterung installieren…",
        "bcam_reinstall": "Browser-Kamera-Erweiterung neu installieren…",
        "bcam_done_title": "Fast fertig: Fügen Sie die Erweiterung zu {browser} hinzu",
        "bcam_done_steps": "1. Schalten Sie in {browser} auf der gerade geöffneten Erweiterungsseite ({url}) den „Entwicklermodus“ ein ({where}) und lassen Sie ihn eingeschaltet: Ohne ihn schaltet der Browser die Erweiterung ab.\n\n2. Klicken Sie auf „Entpackte Erweiterung laden“ und wählen Sie den Ordner „Browser Camera Extension“: Der Finder zeigt ihn an, und sein Pfad ist in der Zwischenablage (drücken Sie im Dialog Befehl-Umschalt-G und fügen Sie ihn ein). Sie können den Ordner auch auf die Erweiterungsseite ziehen.\n\n3. Heften Sie die Erweiterung an: Klicken Sie in der Symbolleiste auf die Schaltfläche „Erweiterungen“ (das Puzzleteil) und dann auf die Stecknadel neben „Remote Visio Camera“ (in Edge auf das Auge). Dann bleibt ihre Schaltfläche in der Symbolleiste.\n\n4. Wählen Sie auf der Website Ihres Meetings „Remote Visio Camera“ als Kamera und klicken Sie auf „Erlauben“, wenn Sie gefragt werden. Laden Sie bereits geöffnete Meeting-Seiten neu.",
        "bcam_devmode_topright": "oben rechts",
        "bcam_devmode_left": "in der linken Spalte",
        "bcam_done_edge": "Edge bietet bei jedem Start an, Erweiterungen im Entwicklermodus zu deaktivieren. Lehnen Sie ab, sonst verschwindet die Kamera.",
        "bcam_done_profiles": "Die Erweiterung und der Entwicklermodus gehören zu einem einzigen Browserprofil, und die Erweiterungsseite hat sich im zuletzt verwendeten Profil geöffnet. Laden Sie die Erweiterung in jedem Profil, das Sie für Meetings nutzen. Sie funktioniert in Chrome, Edge, Brave, Arc und anderen Chromium-Browsern.",
        "bcam_not_chromium_title": "{browser} kann die Erweiterung Remote Visio Camera nicht verwenden",
        "bcam_not_chromium": "Sie funktioniert in Chromium-Browsern. Installieren in:",
        "bcam_no_chromium_title": "Kein Chromium-Browser auf diesem Mac",
        "bcam_no_chromium": "Die Erweiterung Remote Visio Camera funktioniert nur in Chromium-Browsern wie Chrome, Edge, Brave oder Arc, und {browser} gehört nicht dazu. Installieren Sie einen dieser Browser und wählen Sie dann erneut „Browser-Kamera-Erweiterung installieren…“.",
        "bcam_failed": "Die Browser-Kamera-Erweiterung konnte nicht installiert werden",
        "bcam_policy_title": "{browser} lässt diese Erweiterung nicht zu",
        "bcam_policy": "{browser} wird von Ihrer Organisation verwaltet, und deren Richtlinie erlaubt es nicht, Erweiterungen auf diese Weise zu laden. Bitten Sie Ihre IT-Abteilung, die Erweiterung mit der ID {id} und den Entwicklermodus zuzulassen.",
        "bcam_policy_devmode": "{browser} wird von Ihrer Organisation verwaltet, und deren Richtlinie schaltet den Entwicklermodus ab, den diese Erweiterung braucht. Bitten Sie Ihre IT-Abteilung, die Richtlinie ExtensionDeveloperModeSettings auf 0 (zulassen) zu setzen; das genügt, DeveloperToolsAvailability kann bleiben, wie es ist.",
        "bcam_policy_blocklist": "{browser} wird von Ihrer Organisation verwaltet, und deren Richtlinie blockiert diese Erweiterung. Bitten Sie Ihre IT-Abteilung, die Erweiterungs-ID {id} von der Sperrliste zu nehmen (ExtensionInstallBlocklist oder ihr Eintrag in ExtensionSettings).",
        "bcam_policy_blocklist_all": "{browser} wird von Ihrer Organisation verwaltet, und deren Richtlinie blockiert standardmäßig alle Erweiterungen („*“). Die ID dieser Erweiterung zuzulassen, hilft nicht: Solange diese Sperre gilt, lädt der Browser keine entpackte Erweiterung (eine aus einem Ordner geladene wie diese). Bitten Sie Ihre IT-Abteilung, die Sperre aufzuheben („*“ in ExtensionInstallBlocklist oder ExtensionSettings, oder CloudExtensionRequestEnabled).",
        "bcam_policy_types": "{browser} wird von Ihrer Organisation verwaltet, und deren Richtlinie lässt nur bestimmte Arten von Erweiterungen zu. Bitten Sie Ihre IT-Abteilung, „extension“ zu den zugelassenen Typen hinzuzufügen (ExtensionAllowedTypes oder allowed_types in ExtensionSettings).",
        "bcam_policy_other": "Oder installieren Sie sie in einem anderen Browser:",
        "bcam_missing": "In dieser Kopie von Remote Visio fehlt die Browser-Kamera-Erweiterung. Installieren Sie die App neu.",
        "bcam_store_remove_unpacked": "Remote Visio Camera ist in diesem Browser außerdem entpackt geladen (von früher). Sobald die Store-Version hinzugefügt ist, entfernen Sie die alte auf der Erweiterungsseite (die Karte mit der ID jmiffhdbakchdlfbfdiaclkilcdhcgkf), sonst erscheint die Kamera doppelt.",
        "bcam_unpacked_remove_store": "Wenn Sie Remote Visio Camera früher aus dem Chrome Web Store hinzugefügt haben, entfernen Sie diese Version auf der Erweiterungsseite (die Karte mit der ID bhijcffjnmjijifjiaeibbogmbohdmon), sonst erscheint die Kamera doppelt.",
        "bcam_store_steps": "1. Klicken Sie in {browser} auf der gerade geöffneten Seite des Chrome Web Store auf „Hinzufügen“ („Abrufen“ in Edge) und dann auf „Erweiterung hinzufügen“.\n\n2. Heften Sie die Erweiterung an: Klicken Sie in der Symbolleiste auf die Schaltfläche „Erweiterungen“ (das Puzzleteil) und dann auf die Stecknadel neben „Remote Visio Camera“ (in Edge auf das Auge). Dann bleibt ihre Schaltfläche in der Symbolleiste.\n\n3. Wählen Sie auf der Website Ihres Meetings „Remote Visio Camera“ als Kamera und klicken Sie auf „Erlauben“, wenn Sie gefragt werden. Laden Sie bereits geöffnete Meeting-Seiten neu.",
        "bcam_store_edge": "Edge fragt vielleicht zuerst, ob Erweiterungen aus anderen Stores erlaubt werden sollen. Erlauben Sie es und klicken Sie dann auf „Abrufen“.",
        "bcam_store_profiles": "Die Erweiterung gehört zu einem einzigen Browserprofil, und die Store-Seite hat sich im zuletzt verwendeten Profil geöffnet. Fügen Sie sie in jedem Profil hinzu, das Sie für Meetings nutzen. Wenn die Store-Seite nicht funktioniert, wählen Sie „Stattdessen entpackt laden…“ (das braucht den Entwicklermodus).",
        "bcam_unpacked_button": "Stattdessen entpackt laden…",
        "ok": "OK",
        "bcam_policy_blocklist_all_store": "{browser} wird von Ihrer Organisation verwaltet, und deren Richtlinie blockiert standardmäßig alle Erweiterungen („*“). Bitten Sie Ihre IT-Abteilung, die Erweiterungs-ID {id} zuzulassen (ExtensionInstallAllowlist oder ein Eintrag dafür in ExtensionSettings).",
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
        "mic_mute": "Silenzia il microfono di questo Mac",
        "uninstall_q": "Disinstallare Remote Visio?",
        "uninstall_info": "Verranno rimossi il dispositivo audio Remote Visio, la fotocamera virtuale, l'app e il suo elemento di login. Ti verrà chiesta la password di amministratore. L'audio si interrompe per circa un secondo mentre il sistema audio si riavvia. Se hai installato la fotocamera del browser, rimuovi anche «Remote Visio Camera» dalla pagina delle estensioni del browser.",
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
        "bcam_toggle": "Fotocamera del browser",
        "bcam_install": "Installa l'estensione fotocamera del browser…",
        "bcam_reinstall": "Reinstalla l'estensione fotocamera del browser…",
        "bcam_done_title": "Quasi fatto: aggiungi l'estensione a {browser}",
        "bcam_done_steps": "1. In {browser}, nella pagina delle estensioni appena aperta ({url}), attiva «Modalità sviluppatore» ({where}) e lasciala attiva: senza di essa il browser disattiva l'estensione.\n\n2. Fai clic su «Carica estensione non pacchettizzata» e scegli la cartella «Browser Camera Extension»: il Finder la mostra e il suo percorso è negli appunti (premi Comando-Maiuscole-G nella finestra di dialogo, poi incolla). In alternativa, trascina la cartella sulla pagina delle estensioni.\n\n3. Fissa l'estensione: fai clic sul pulsante Estensioni (il pezzo di puzzle) nella barra degli strumenti, poi sulla puntina accanto a «Remote Visio Camera» (l'occhio in Edge). Così il suo pulsante resta nella barra degli strumenti.\n\n4. Nel sito della riunione, scegli «Remote Visio Camera» come fotocamera e fai clic su Consenti quando richiesto. Ricarica le pagine delle riunioni già aperte.",
        "bcam_devmode_topright": "in alto a destra",
        "bcam_devmode_left": "nella colonna di sinistra",
        "bcam_done_edge": "A ogni avvio, Edge propone di disattivare le estensioni in modalità sviluppatore. Non accettare, o la fotocamera sparisce.",
        "bcam_done_profiles": "L'estensione e la modalità sviluppatore appartengono a un solo profilo del browser, e la pagina delle estensioni si è aperta nell'ultimo profilo usato. Carica l'estensione in ogni profilo che usi per le riunioni. Funziona in Chrome, Edge, Brave, Arc e negli altri browser Chromium.",
        "bcam_not_chromium_title": "{browser} non può usare l'estensione Remote Visio Camera",
        "bcam_not_chromium": "Funziona nei browser Chromium. Installala in:",
        "bcam_no_chromium_title": "Nessun browser Chromium su questo Mac",
        "bcam_no_chromium": "L'estensione Remote Visio Camera funziona solo nei browser Chromium, come Chrome, Edge, Brave o Arc, e {browser} non è tra questi. Installa uno di questi browser, poi scegli di nuovo «Installa l'estensione fotocamera del browser…».",
        "bcam_failed": "Impossibile installare l'estensione fotocamera del browser",
        "bcam_policy_title": "{browser} non consente questa estensione",
        "bcam_policy": "{browser} è gestito dalla tua organizzazione e i suoi criteri non ti consentono di caricare estensioni in questo modo. Chiedi al reparto IT di consentire l'estensione con ID {id} e la modalità sviluppatore.",
        "bcam_policy_devmode": "{browser} è gestito dalla tua organizzazione e i suoi criteri disattivano la modalità sviluppatore, che serve a questa estensione. Chiedi al reparto IT di impostare il criterio ExtensionDeveloperModeSettings a 0 (consenti); basta questo, DeveloperToolsAvailability può restare com'è.",
        "bcam_policy_blocklist": "{browser} è gestito dalla tua organizzazione e i suoi criteri bloccano questa estensione. Chiedi al reparto IT di togliere l'ID estensione {id} dall'elenco di blocco (ExtensionInstallBlocklist, o la sua voce in ExtensionSettings).",
        "bcam_policy_blocklist_all": "{browser} è gestito dalla tua organizzazione e i suoi criteri bloccano tutte le estensioni per impostazione predefinita («*»). Consentire l'ID di questa estensione non serve: finché il blocco resta, il browser non carica nessuna estensione non pacchettizzata (caricata da una cartella, come questa). Chiedi al reparto IT di togliere il blocco («*» in ExtensionInstallBlocklist o ExtensionSettings, oppure CloudExtensionRequestEnabled).",
        "bcam_policy_types": "{browser} è gestito dalla tua organizzazione e i suoi criteri consentono solo alcuni tipi di estensioni. Chiedi al reparto IT di aggiungere «extension» ai tipi consentiti (ExtensionAllowedTypes, o allowed_types in ExtensionSettings).",
        "bcam_policy_other": "Oppure installala in un altro browser:",
        "bcam_missing": "In questa copia di Remote Visio manca l'estensione fotocamera del browser. Reinstalla l'app.",
        "bcam_store_remove_unpacked": "Remote Visio Camera è anche caricata non pacchettizzata in questo browser (da prima). Dopo aver aggiunto la copia dello store, rimuovi quella vecchia nella pagina delle estensioni (la scheda con l'ID jmiffhdbakchdlfbfdiaclkilcdhcgkf), altrimenti la fotocamera compare due volte.",
        "bcam_unpacked_remove_store": "Se in precedenza hai aggiunto Remote Visio Camera dal Chrome Web Store, rimuovi quella copia nella pagina delle estensioni (la scheda con l'ID bhijcffjnmjijifjiaeibbogmbohdmon), altrimenti la fotocamera compare due volte.",
        "bcam_store_steps": "1. In {browser}, nella pagina del Chrome Web Store appena aperta, fai clic su «Aggiungi» («Ottieni» in Edge), poi su «Aggiungi estensione».\n\n2. Fissa l'estensione: fai clic sul pulsante Estensioni (il pezzo di puzzle) nella barra degli strumenti, poi sulla puntina accanto a «Remote Visio Camera» (l'occhio in Edge). Così il suo pulsante resta nella barra degli strumenti.\n\n3. Nel sito della riunione, scegli «Remote Visio Camera» come fotocamera e fai clic su Consenti quando richiesto. Ricarica le pagine delle riunioni già aperte.",
        "bcam_store_edge": "Edge potrebbe prima chiederti di consentire le estensioni di altri store. Consentilo, poi fai clic su «Ottieni».",
        "bcam_store_profiles": "L'estensione appartiene a un solo profilo del browser, e la pagina dello store si è aperta nell'ultimo profilo usato. Aggiungila in ogni profilo che usi per le riunioni. Se la pagina dello store non funziona, scegli «Carica non pacchettizzata…» (serve la modalità sviluppatore).",
        "bcam_unpacked_button": "Carica non pacchettizzata…",
        "ok": "OK",
        "bcam_policy_blocklist_all_store": "{browser} è gestito dalla tua organizzazione e i suoi criteri bloccano tutte le estensioni per impostazione predefinita («*»). Chiedi al reparto IT di consentire l'ID estensione {id} (ExtensionInstallAllowlist, o una voce per essa in ExtensionSettings).",
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
        "mic_mute": "इस Mac का माइक्रोफ़ोन म्यूट करें",
        "uninstall_q": "Remote Visio हटाएँ?",
        "uninstall_info": "इससे Remote Visio ऑडियो डिवाइस, वर्चुअल कैमरा, यह ऐप और इसका लॉगिन आइटम हट जाएँगे। आपसे व्यवस्थापक पासवर्ड माँगा जाएगा। ऑडियो सिस्टम के रीस्टार्ट होने के दौरान आवाज़ लगभग एक सेकंड के लिए रुकेगी। अगर आपने ब्राउज़र कैमरा इंस्टॉल किया था, तो अपने ब्राउज़र के एक्सटेंशन पेज से \"Remote Visio Camera\" भी हटाएँ।",
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
        "bcam_toggle": "ब्राउज़र कैमरा",
        "bcam_install": "ब्राउज़र कैमरा एक्सटेंशन इंस्टॉल करें…",
        "bcam_reinstall": "ब्राउज़र कैमरा एक्सटेंशन दोबारा इंस्टॉल करें…",
        "bcam_done_title": "लगभग हो गया: एक्सटेंशन को {browser} में जोड़ें",
        "bcam_done_steps": "1. {browser} में अभी खुले एक्सटेंशन पेज ({url}) पर \"डेवलपर मोड\" चालू करें ({where}) और इसे चालू ही रहने दें: इसके बिना ब्राउज़र एक्सटेंशन बंद कर देता है।\n\n2. \"पैक नहीं किया गया एक्सटेंशन लोड करें\" पर क्लिक करें और \"Browser Camera Extension\" फ़ोल्डर चुनें: Finder उसे दिखा रहा है, और उसका पाथ क्लिपबोर्ड पर है (डायलॉग में Command-Shift-G दबाएँ, फिर पेस्ट करें)। या उस फ़ोल्डर को खींचकर एक्सटेंशन पेज पर छोड़ दें।\n\n3. एक्सटेंशन को पिन करें: टूलबार में एक्सटेंशन बटन (पहेली के टुकड़े वाला आइकन) पर क्लिक करें, फिर \"Remote Visio Camera\" के पास वाले पिन पर (Edge में आँख वाले आइकन पर)। तब इसका बटन टूलबार में बना रहता है।\n\n4. अपनी मीटिंग की वेबसाइट पर कैमरे के रूप में \"Remote Visio Camera\" चुनें, और पूछे जाने पर \"अनुमति दें\" पर क्लिक करें। जो मीटिंग पेज पहले से खुले थे, उन्हें फिर से लोड करें।",
        "bcam_devmode_topright": "ऊपर दाईं ओर",
        "bcam_devmode_left": "बाएँ कॉलम में",
        "bcam_done_edge": "Edge हर बार शुरू होने पर डेवलपर मोड वाले एक्सटेंशन बंद करने का सुझाव देता है। इसे स्वीकार न करें, वरना कैमरा गायब हो जाएगा।",
        "bcam_done_profiles": "एक्सटेंशन और डेवलपर मोड एक ही ब्राउज़र प्रोफ़ाइल के होते हैं, और एक्सटेंशन पेज उस प्रोफ़ाइल में खुला है जिसे आपने पिछली बार इस्तेमाल किया था। मीटिंग के लिए इस्तेमाल होने वाली हर प्रोफ़ाइल में एक्सटेंशन लोड करें। यह एक्सटेंशन Chrome, Edge, Brave, Arc और दूसरे Chromium ब्राउज़र में काम करता है।",
        "bcam_not_chromium_title": "{browser} में Remote Visio Camera एक्सटेंशन काम नहीं करता",
        "bcam_not_chromium": "यह Chromium ब्राउज़र में काम करता है। इसमें इंस्टॉल करें:",
        "bcam_no_chromium_title": "इस Mac पर कोई Chromium ब्राउज़र नहीं है",
        "bcam_no_chromium": "Remote Visio Camera एक्सटेंशन सिर्फ़ Chromium ब्राउज़र में काम करता है, जैसे Chrome, Edge, Brave या Arc, और {browser} उनमें से नहीं है। इनमें से कोई ब्राउज़र इंस्टॉल करें, फिर \"ब्राउज़र कैमरा एक्सटेंशन इंस्टॉल करें…\" दोबारा चुनें।",
        "bcam_failed": "ब्राउज़र कैमरा एक्सटेंशन इंस्टॉल नहीं हो सका",
        "bcam_policy_title": "{browser} इस एक्सटेंशन की अनुमति नहीं देता",
        "bcam_policy": "{browser} को आपका संगठन प्रबंधित करता है, और उसकी नीति इस तरह एक्सटेंशन लोड करने की अनुमति नहीं देती। अपने IT विभाग से ID {id} वाले एक्सटेंशन और डेवलपर मोड की अनुमति देने को कहें।",
        "bcam_policy_devmode": "{browser} को आपका संगठन प्रबंधित करता है, और उसकी नीति डेवलपर मोड बंद कर देती है, जिसकी इस एक्सटेंशन को ज़रूरत है। अपने IT विभाग से ExtensionDeveloperModeSettings नीति को 0 (अनुमति दें) पर सेट करने को कहें; इतना काफ़ी है, DeveloperToolsAvailability जैसी है वैसी रह सकती है।",
        "bcam_policy_blocklist": "{browser} को आपका संगठन प्रबंधित करता है, और उसकी नीति इस एक्सटेंशन को रोकती है। अपने IT विभाग से एक्सटेंशन ID {id} को ब्लॉकलिस्ट से हटाने को कहें (ExtensionInstallBlocklist, या ExtensionSettings में इसकी एंट्री)।",
        "bcam_policy_blocklist_all": "{browser} को आपका संगठन प्रबंधित करता है, और उसकी नीति डिफ़ॉल्ट रूप से सभी एक्सटेंशन रोकती है (\"*\")। इस एक्सटेंशन की ID को अनुमति देने से कुछ नहीं होगा: जब तक यह रोक लगी है, ब्राउज़र कोई भी पैक न किया गया एक्सटेंशन (इसकी तरह किसी फ़ोल्डर से लोड किया गया) लोड नहीं करता। अपने IT विभाग से यह रोक हटाने को कहें (ExtensionInstallBlocklist या ExtensionSettings में \"*\", या CloudExtensionRequestEnabled)।",
        "bcam_policy_types": "{browser} को आपका संगठन प्रबंधित करता है, और उसकी नीति सिर्फ़ कुछ तरह के एक्सटेंशन की अनुमति देती है। अपने IT विभाग से अनुमति वाले प्रकारों में \"extension\" जोड़ने को कहें (ExtensionAllowedTypes, या ExtensionSettings में allowed_types)।",
        "bcam_policy_other": "या इसे किसी दूसरे ब्राउज़र में इंस्टॉल करें:",
        "bcam_missing": "Remote Visio की इस कॉपी में ब्राउज़र कैमरा एक्सटेंशन नहीं है। ऐप को दोबारा इंस्टॉल करें।",
        "bcam_store_remove_unpacked": "इस ब्राउज़र में Remote Visio Camera पहले से अनपैक्ड रूप में भी लोड है। स्टोर वाली कॉपी जोड़ने के बाद, एक्सटेंशन पेज पर पुरानी कॉपी हटाएँ (ID jmiffhdbakchdlfbfdiaclkilcdhcgkf वाला कार्ड), वरना कैमरा दो बार दिखेगा।",
        "bcam_unpacked_remove_store": "अगर आपने पहले Chrome Web Store से Remote Visio Camera जोड़ा था, तो एक्सटेंशन पेज पर वह कॉपी हटाएँ (ID bhijcffjnmjijifjiaeibbogmbohdmon वाला कार्ड), वरना कैमरा दो बार दिखेगा।",
        "bcam_store_steps": "1. {browser} में अभी खुले Chrome Web Store पेज पर \"Chrome में जोड़ें\" (Edge में \"पाएँ\") पर क्लिक करें, फिर \"एक्सटेंशन जोड़ें\" पर।\n\n2. एक्सटेंशन को पिन करें: टूलबार में एक्सटेंशन बटन (पहेली के टुकड़े वाला आइकन) पर क्लिक करें, फिर \"Remote Visio Camera\" के पास वाले पिन पर (Edge में आँख वाले आइकन पर)। तब इसका बटन टूलबार में बना रहता है।\n\n3. अपनी मीटिंग की वेबसाइट पर कैमरे के रूप में \"Remote Visio Camera\" चुनें, और पूछे जाने पर \"अनुमति दें\" पर क्लिक करें। जो मीटिंग पेज पहले से खुले थे, उन्हें फिर से लोड करें।",
        "bcam_store_edge": "Edge पहले दूसरे स्टोर के एक्सटेंशन की अनुमति माँग सकता है। अनुमति दें, फिर \"पाएँ\" पर क्लिक करें।",
        "bcam_store_profiles": "एक्सटेंशन एक ही ब्राउज़र प्रोफ़ाइल का होता है, और स्टोर पेज उस प्रोफ़ाइल में खुला है जिसे आपने पिछली बार इस्तेमाल किया था। मीटिंग के लिए इस्तेमाल होने वाली हर प्रोफ़ाइल में इसे जोड़ें। अगर स्टोर पेज काम न करे, तो \"इसके बजाय अनपैक्ड लोड करें…\" चुनें (इसके लिए डेवलपर मोड चाहिए)।",
        "bcam_unpacked_button": "इसके बजाय अनपैक्ड लोड करें…",
        "ok": "ठीक है",
        "bcam_policy_blocklist_all_store": "{browser} को आपका संगठन प्रबंधित करता है, और उसकी नीति डिफ़ॉल्ट रूप से सभी एक्सटेंशन ब्लॉक करती है (\"*\")। अपने IT विभाग से एक्सटेंशन ID {id} की अनुमति देने को कहें (ExtensionInstallAllowlist, या ExtensionSettings में इसके लिए एक प्रविष्टि)।",
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

// The browser camera's installer, which macos/assemble-app.sh puts in
// Contents/Resources next to the extension files it copies
// (BrowserExtension/). It does the file work and the browser detection; the
// app runs it and talks to the user.
private let browserExtensionScript = Bundle.main.path(forResource: "browser-extension", ofType: "sh")

// One run of browser-extension.sh: its exit status, its key=value lines
// (the chromium= lines, one per installed Chromium browser, in the script's
// order, the default browser first; after a management policy refused the
// install, the policy_blocked= lines, one per Chromium browser whose policy
// refuses it too) and what it said on stderr.
private struct BrowserExtensionRun {
    struct Browser {
        let id: String
        let name: String
    }
    var status: Int32
    var values: [String: String] = [:]
    var chromium: [Browser] = []
    var policyBlocked: [String] = []
    var stderr = ""
}

// Run browser-extension.sh with `arguments` and wait for it. Blocks, so
// callers on the main thread keep to the quick subcommands (path, remove);
// install and sync run on a background queue. The script runs under the
// system's bash (3.2), which it is written for, whatever PATH says.
private func runBrowserExtensionScript(_ arguments: [String]) -> BrowserExtensionRun {
    guard let script = browserExtensionScript else {
        return BrowserExtensionRun(status: -1, stderr: L("bcam_missing"))
    }
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/bin/bash")
    proc.arguments = [script] + arguments
    proc.standardInput = FileHandle.nullDevice
    let out = Pipe()
    let err = Pipe()
    proc.standardOutput = out
    proc.standardError = err
    do {
        try proc.run()
    } catch {
        return BrowserExtensionRun(status: -1, stderr: error.localizedDescription)
    }
    // Drain stderr on another thread while this one reads stdout: a pipe
    // holds only so much, and a script blocked writing to one while this
    // waits on the other would never finish.
    var errData = Data()
    let drained = DispatchGroup()
    drained.enter()
    DispatchQueue.global(qos: .utility).async {
        errData = err.fileHandleForReading.readDataToEndOfFile()
        drained.leave()
    }
    let outData = out.fileHandleForReading.readDataToEndOfFile()
    drained.wait()
    proc.waitUntilExit()

    var run = BrowserExtensionRun(status: proc.terminationStatus)
    run.stderr = String(decoding: errData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    for line in String(decoding: outData, as: UTF8.self).split(separator: "\n") {
        guard let eq = line.firstIndex(of: "=") else { continue }
        let key = String(line[..<eq])
        let value = String(line[line.index(after: eq)...])
        if key == "chromium" {
            // <bundle id>|<name>|<app path>
            let parts = value.split(separator: "|", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
            if parts.count == 3 { run.chromium.append(.init(id: parts[0], name: parts[1])) }
        } else if key == "policy_blocked" {
            run.policyBlocked.append(value)
        } else {
            run.values[key] = value
        }
    }
    return run
}

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
    // An install of the browser camera is running (the script, in the
    // background): the menu item waits for it.
    private var browserExtensionBusy = false

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

        // An update of this app may bring new browser extension files:
        // refresh the copy the browser loads (it picks them up at its next
        // restart). In the background, and whatever the outcome: the launch
        // never waits for it, and a failure only leaves the old copy.
        // Unless that copy is gone (deleted by hand, or by the uninstaller
        // run from Terminal before this install): then the browser camera
        // is not installed any more, sync would not bring it back, and the
        // menu offers to install it again. This comes before the receiver
        // starts, so that it starts without -browser-camera. A symbolic
        // link counts as there even when broken: a developer's, which sync
        // leaves alone.
        // An extension installed from the store has no such copy (the store
        // keeps it up to date), so a missing folder means nothing then; an
        // unpacked copy left from before, which the browser may still load,
        // is kept up to date all the same (sync does nothing without one).
        if UserDefaults.standard.bool(forKey: browserCameraInstalledKey), browserExtensionScript != nil {
            let path = runBrowserExtensionScript(["path"])
            if UserDefaults.standard.string(forKey: browserCameraModeKey) != "store",
               path.status == 0, let folder = path.values["folder"], !folder.isEmpty,
               !FileManager.default.fileExists(atPath: folder),
               (try? FileManager.default.destinationOfSymbolicLink(atPath: folder)) == nil {
                UserDefaults.standard.removeObject(forKey: browserCameraInstalledKey)
                UserDefaults.standard.removeObject(forKey: browserCameraKey)
                UserDefaults.standard.removeObject(forKey: browserCameraModeKey)
            } else {
                DispatchQueue.global(qos: .utility).async {
                    _ = runBrowserExtensionScript(["sync"])
                }
            }
        }

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

    // Same for -mic-mute: the stopping receiver puts the microphones back,
    // the new one mutes them again, or not.
    @objc private func toggleMicMute() {
        let on = !UserDefaults.standard.bool(forKey: micMuteKey)
        UserDefaults.standard.set(on, forKey: micMuteKey)
        stopReceiver()
        launchReceiver(fresh: false)
    }

    // Same for -camera, and for -browser-camera, which it switches as well.
    @objc private func toggleCameraRelay() {
        let off = !UserDefaults.standard.bool(forKey: cameraOffKey)
        UserDefaults.standard.set(off, forKey: cameraOffKey)
        stopReceiver()
        launchReceiver(fresh: false)
    }

    // Same for -browser-camera. The menu offers it only while the camera
    // relay is on, so this always changes what the receiver does. It is
    // always in the menu: the extension may come straight from the store,
    // without this app's install step.
    @objc private func toggleBrowserCamera() {
        let on = !UserDefaults.standard.bool(forKey: browserCameraKey)
        UserDefaults.standard.set(on, forKey: browserCameraKey)
        stopReceiver()
        launchReceiver(fresh: false)
    }

    // "Install Browser Camera Extension…": the user asked for it, and only
    // they can finish it. The script finds the default browser and, when it
    // is a Chromium browser its organization lets install the extension,
    // opens the extension's Chrome Web Store page there; this then switches
    // the browser camera on and explains the steps left ("Add to Chrome",
    // which a browser lets no program click). The unpacked way stays as the
    // way out when the store cannot be used: the script copies the extension
    // to a folder in the user's home, opens the browser's extensions page,
    // shows the folder in Finder and puts its path on the clipboard, for
    // Developer mode and "Load unpacked". A default browser that cannot run
    // the extension, or whose management policy does not let the user
    // install it, gets a choice of the other Chromium browsers installed.
    @objc private func installBrowserCamera() {
        startBrowserCameraInstall(browser: nil, unpacked: false)
    }

    // The script runs on a background queue (opening the browser can take a
    // few seconds when it has to start), the answer comes back here.
    private func startBrowserCameraInstall(browser: String?, unpacked: Bool) {
        guard !browserExtensionBusy else { return }
        guard browserExtensionScript != nil else {
            showAlert(style: .critical, title: "Remote Visio", text: L("bcam_missing"))
            return
        }
        browserExtensionBusy = true
        var arguments = ["install"]
        if let browser = browser { arguments += ["--browser", browser] }
        if unpacked { arguments.append("--unpacked") }
        DispatchQueue.global(qos: .userInitiated).async {
            let run = runBrowserExtensionScript(arguments)
            DispatchQueue.main.async {
                self.browserExtensionBusy = false
                self.browserCameraInstallFinished(run, unpacked: unpacked)
            }
        }
    }

    private func browserCameraInstallFinished(_ run: BrowserExtensionRun, unpacked: Bool) {
        let browserName = run.values["browser_name"] ?? run.values["default_name"] ?? ""
        switch run.status {
        case 0:
            // Switch it on, restarting the receiver when that changes its
            // arguments (not when the camera relay is off: that stays the
            // user's choice).
            let before = receiverArguments()
            // The other way's copy may be in the browser already (an
            // unpacked one from before the store, or the store's when the
            // user now loads it unpacked): two copies list the camera twice,
            // so the steps say to remove the other one.
            let previousMode = UserDefaults.standard.string(forKey: browserCameraModeKey)
            let hadInstall = UserDefaults.standard.bool(forKey: browserCameraInstalledKey)
            var otherCopy = false
            if !unpacked, let folder = runBrowserExtensionScript(["path"]).values["folder"], !folder.isEmpty {
                otherCopy = FileManager.default.fileExists(atPath: folder)
                    || (try? FileManager.default.destinationOfSymbolicLink(atPath: folder)) != nil
            } else if unpacked {
                otherCopy = hadInstall && previousMode == "store"
            }
            UserDefaults.standard.set(true, forKey: browserCameraInstalledKey)
            UserDefaults.standard.set(true, forKey: browserCameraKey)
            UserDefaults.standard.set(unpacked ? "unpacked" : "store", forKey: browserCameraModeKey)
            if receiverArguments() != before {
                stopReceiver()
                launchReceiver(fresh: false)
            }
            if !unpacked {
                // The store's page is open: "Add to Chrome" is left, and
                // Edge may first ask to allow other stores. A store page
                // that does not work (not reachable, not published, blocked)
                // has the unpacked way as the alternative.
                var steps = L("bcam_store_steps", ["browser": browserName])
                if (run.values["browser_bundle"] ?? "").lowercased().hasPrefix("com.microsoft.edgemac") {
                    steps += "\n\n" + L("bcam_store_edge")
                }
                steps += "\n\n" + L("bcam_store_profiles")
                if otherCopy { steps += "\n\n" + L("bcam_store_remove_unpacked") }
                let alert = NSAlert()
                alert.alertStyle = .informational
                alert.messageText = L("bcam_done_title", ["browser": browserName])
                alert.informativeText = steps
                alert.addButton(withTitle: L("ok"))
                alert.addButton(withTitle: L("bcam_unpacked_button"))
                NSApp.activate(ignoringOtherApps: true)
                if alert.runModal() == .alertSecondButtonReturn {
                    startBrowserCameraInstall(browser: run.values["browser_bundle"], unpacked: true)
                }
                return
            }
            // The steps, with what differs by browser: where its extensions
            // page has the Developer mode switch (the script knows), and
            // Edge's prompt, at every start, to switch off the extensions
            // Developer mode loaded, the camera among them. Then a note for
            // those with several browser profiles: the page opened in the
            // last one used, and each profile has its own extensions.
            let whereKey = run.values["devmode_where"] == "left" ? "bcam_devmode_left" : "bcam_devmode_topright"
            var steps = L("bcam_done_steps", ["browser": browserName,
                                              "url": run.values["extensions_url"] ?? "chrome://extensions",
                                              "where": L(whereKey)])
            if (run.values["browser_bundle"] ?? "").lowercased().hasPrefix("com.microsoft.edgemac") {
                steps += "\n\n" + L("bcam_done_edge")
            }
            steps += "\n\n" + L("bcam_done_profiles")
            if otherCopy { steps += "\n\n" + L("bcam_unpacked_remove_store") }
            showAlert(style: .informational, title: L("bcam_done_title", ["browser": browserName]), text: steps)
        case 3 where !run.chromium.isEmpty:
            // The default browser (Safari, Firefox …) cannot run it: offer
            // the Chromium browsers installed.
            chooseBrowser(from: run.chromium, unpacked: unpacked, style: .informational,
                          title: L("bcam_not_chromium_title", ["browser": browserName]),
                          text: L("bcam_not_chromium"))
        case 3, 4:
            showAlert(style: .warning, title: L("bcam_no_chromium_title"),
                      text: L("bcam_no_chromium", ["browser": browserName]))
        case 5:
            // The browser's management policy blocks it. Only the
            // organization can change that, and what it has to change
            // depends on the rule (policy=): allowing the extension's ID
            // does nothing against Developer mode switched off, say. The
            // other Chromium browsers installed are offered, but not those
            // the policy blocks too (policy_blocked=); with none left, the
            // alert says nothing about another browser.
            let policyKey: String
            switch run.values["policy"] {
            case "developer-mode"?: policyKey = "bcam_policy_devmode"
            case "blocklist"?: policyKey = "bcam_policy_blocklist"
            // From the store, allowing the ID gets through a "*" block;
            // unpacked, nothing but lifting the block does.
            case "blocklist-all"?: policyKey = unpacked ? "bcam_policy_blocklist_all" : "bcam_policy_blocklist_all_store"
            case "types"?: policyKey = "bcam_policy_types"
            default: policyKey = "bcam_policy"
            }
            let title = L("bcam_policy_title", ["browser": browserName])
            let text = L(policyKey, ["browser": browserName,
                                     "id": run.values["extension_id"] ?? (unpacked ? "jmiffhdbakchdlfbfdiaclkilcdhcgkf" : "bhijcffjnmjijifjiaeibbogmbohdmon")])
            let blocked = run.policyBlocked + [run.values["browser_bundle"] ?? ""]
            let others = run.chromium.filter { browser in
                !blocked.contains { $0.caseInsensitiveCompare(browser.id) == .orderedSame }
            }
            // From the store, the unpacked way may still be open (a policy
            // that blocks only the store's copy): the script says so.
            let unpackedWay = !unpacked && run.values["unpacked_ok"] == "1" ? run.values["browser_bundle"] : nil
            if others.isEmpty && unpackedWay == nil {
                showAlert(style: .warning, title: title, text: text)
            } else {
                chooseBrowser(from: others, unpacked: unpacked, style: .warning, title: title,
                              text: others.isEmpty ? text : text + "\n\n" + L("bcam_policy_other"),
                              unpackedIn: unpackedWay)
            }
        default:
            // The script's own error lines ("!!  …") when there are any;
            // what it reports along the way is not the point here.
            let errors = run.stderr.split(separator: "\n").filter { $0.hasPrefix("!!") }
                .map { $0.dropFirst(2).trimmingCharacters(in: .whitespaces) }
            let detail = !errors.isEmpty ? errors.joined(separator: "\n")
                : !run.stderr.isEmpty ? run.stderr : "status \(run.status)"
            showAlert(style: .critical, title: L("bcam_failed"), text: detail)
        }
    }

    private func showAlert(style: NSAlert.Style, title: String, text: String) {
        let alert = NSAlert()
        alert.alertStyle = style
        alert.messageText = title
        alert.informativeText = text
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    // An alert whose buttons are Chromium browsers to install the extension
    // into instead, in the script's order, at most three so it stays
    // readable, plus Cancel. The one clicked gets a new install, which checks
    // it from the start (its management policy included).
    // unpackedIn, when set, adds "Load Unpacked Instead…" for that browser.
    private func chooseBrowser(from browsers: [BrowserExtensionRun.Browser], unpacked: Bool, style: NSAlert.Style,
                               title: String, text: String, unpackedIn: String? = nil) {
        let choices = Array(browsers.prefix(3))
        let alert = NSAlert()
        alert.alertStyle = style
        alert.messageText = title
        alert.informativeText = text
        for choice in choices {
            alert.addButton(withTitle: choice.name)
        }
        if unpackedIn != nil {
            alert.addButton(withTitle: L("bcam_unpacked_button"))
        }
        alert.addButton(withTitle: L("cancel")).keyEquivalent = "\u{1b}"
        NSApp.activate(ignoringOtherApps: true)
        let index = alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        if index >= 0 && index < choices.count {
            startBrowserCameraInstall(browser: choices[index].id, unpacked: unpacked)
        } else if index == choices.count, let browser = unpackedIn {
            startBrowserCameraInstall(browser: browser, unpacked: true)
        }
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

    // The receiver's switches, from the menu's settings. "Relay the Camera"
    // off is the master switch: neither the virtual camera nor the browser
    // camera then.
    private func receiverArguments() -> [String] {
        let defaults = UserDefaults.standard
        var arguments: [String] = []
        if defaults.bool(forKey: speakerMuteKey) { arguments.append("-speaker-mute") }
        if defaults.bool(forKey: micMuteKey) { arguments.append("-mic-mute") }
        if defaults.bool(forKey: cameraOffKey) {
            arguments.append("-camera=false")
        } else if defaults.bool(forKey: browserCameraKey) {
            arguments.append("-browser-camera")
        }
        return arguments
    }

    // Start the bundled receiver. It exits with status 3 when its audio device
    // stops responding (coreaudiod restarted, e.g. after a driver reinstall);
    // that is a request to be started again, not a failure. The log is
    // truncated once per app launch and appended to on relaunches, so the line
    // explaining why the previous instance exited survives.
    private func launchReceiver(fresh: Bool) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: receiverPath)
        proc.arguments = receiverArguments()

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

    // Put back the microphones a crashed -mic-mute run left muted. Each start
    // of the receiver does it, but after the uninstall there is none; the
    // stopped receiver has already put back its own.
    private func restoreMicrophones() {
        guard FileManager.default.isExecutableFile(atPath: receiverPath) else { return }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: receiverPath)
        proc.arguments = ["-mic-restore"]
        let done = DispatchSemaphore(value: 0)
        proc.terminationHandler = { _ in done.signal() }
        guard (try? proc.run()) != nil else { return }
        if done.wait(timeout: .now() + 10) == .timedOut { proc.terminate() }
    }

    // Menu-driven uninstall: confirm, drop the login item, deactivate the
    // camera extension (macOS asks for the admin password; the app has to
    // still exist for that, so it comes first), stop the receiver, then run
    // the bundled uninstall script as root through the standard macOS
    // password dialog. It removes the audio device driver, restarts
    // coreaudiod, deletes the app and forgets the package receipts. The
    // browser camera's folder goes just before, as the user: it is in their
    // home, and the script that removes it is inside the app.
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
        restoreMicrophones()
        let removedBrowserExtension = runBrowserExtensionScript(["remove"]).values["removed"] == "1"

        // Paths come from the bundle; quote them for the shell all the same.
        let quoted = "'" + script.replacingOccurrences(of: "'", with: "'\\''") + "'"
        let source = "do shell script \"\(quoted) --from-app\" with administrator privileges"
        var error: NSDictionary?
        if NSAppleScript(source: source)?.executeAndReturnError(&error) != nil {
            // The browser camera is gone with the app; a later install of
            // Remote Visio starts without it.
            UserDefaults.standard.removeObject(forKey: browserCameraInstalledKey)
            UserDefaults.standard.removeObject(forKey: browserCameraKey)
            UserDefaults.standard.removeObject(forKey: browserCameraModeKey)
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
        // back the way they were, the camera extension included, and the
        // browser camera's folder, which the browser still loads from
        // (`install --unpacked --no-open` makes the copy and opens nothing).
        let code = (error?[NSAppleScript.errorNumber] as? Int) ?? 0
        activateCameraExtensionIfInstalled()
        if removedBrowserExtension {
            _ = runBrowserExtensionScript(["install", "--unpacked", "--no-open"])
        }
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
        let micMute = NSMenuItem(title: L("mic_mute"), action: #selector(toggleMicMute), keyEquivalent: "")
        micMute.target = self
        micMute.state = UserDefaults.standard.bool(forKey: micMuteKey) ? .on : .off
        menu.addItem(micMute)
        // "Relay the Camera", the master switch, and the Browser Camera
        // switch under it, always: the browser camera extension can come
        // straight from the Chrome Web Store, without this app's install
        // step, and its user has to be able to switch it on here. The
        // Browser Camera switch is greyed out (its check mark kept) while
        // the relay is off, since it then has no effect.
        let browserCameraInstalled = UserDefaults.standard.bool(forKey: browserCameraInstalledKey)
        let cameraOff = UserDefaults.standard.bool(forKey: cameraOffKey)
        let camera = NSMenuItem(title: L("camera_toggle"), action: #selector(toggleCameraRelay), keyEquivalent: "")
        camera.target = self
        camera.state = cameraOff ? .off : .on
        menu.addItem(camera)
        let browserCamera = NSMenuItem(title: L("bcam_toggle"),
                                       action: cameraOff ? nil : #selector(toggleBrowserCamera), keyEquivalent: "")
        browserCamera.target = self
        browserCamera.state = UserDefaults.standard.bool(forKey: browserCameraKey) ? .on : .off
        browserCamera.indentationLevel = 1
        menu.addItem(browserCamera)
        // Always offered: the browser camera is optional, and only the user
        // sets it up. Greyed out while an install is under way.
        let installBrowser = NSMenuItem(title: L(browserCameraInstalled ? "bcam_reinstall" : "bcam_install"),
                                        action: browserExtensionBusy ? nil : #selector(installBrowserCamera),
                                        keyEquivalent: "")
        installBrowser.target = self
        menu.addItem(installBrowser)
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
