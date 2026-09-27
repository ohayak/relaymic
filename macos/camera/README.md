# Remote Visio Camera (virtual camera system extension)

`main.swift` is a Core Media I/O camera extension (`CMIOExtension`; the pattern Apple DTS recommends
and OBS uses). It publishes one virtual camera, **Remote Visio Camera**, with a SOURCE stream that
Zoom, FaceTime, Teams and QuickTime capture from, and a SINK stream that the receiver (`cmd/receiver`,
through the CMIO C API) writes the remote camera's decoded frames into. Frames are forwarded
sink → source; while none arrive, a "Remote Visio — waiting for the remote camera…" placeholder is shown.

Fixed identifiers (constants at the top of `main.swift`; the receiver relies on them): bundle id
`com.remotevisio.app.camera`; device `Remote Visio Camera`, UID `7A5D8C2E-2C4B-4E6F-9A1B-3D5F7E9C1B2D`;
source stream `Remote Visio Camera`, `B1C2D3E4-F5A6-4B7C-8D9E-0F1A2B3C4D5E` (added first); sink stream
`Remote Visio Camera Sink`, `C2D3E4F5-A6B7-4C8D-9E0F-1A2B3C4D5E6F`.

Sink contract: only a client whose code-signing identifier is `remotevisio-receiver`,
`com.remotevisio.receiver` or `com.remotevisio.app` may start the sink (others are logged and refused),
and one at a time: a second client is refused while the first streams (start and stop arrive per client
and the stop names no client, so a takeover would end with the wrong session torn down).
It writes CVPixelBuffer-backed CMSampleBuffers, NV12 (`420v`) or BGRA of any size, with host-clock
presentation times; the declared format is 1920x1080 BGRA at 30 fps. Queue depth is 1 (one frame in
flight; deeper only adds latency). Frames are re-stamped with the host clock before forwarding; a gap
repeats the last frame for up to a second, then the placeholder returns.
Logs: `log stream --predicate 'subsystem == "com.remotevisio.app.camera"'`.

Build and signing: the Makefile compiles `main.swift` with plain `swiftc` (no Xcode project; it fills in
`@VERSION@`/`@MINOS@` in `Info.plist`) and `assemble-app.sh` nests the bundle in
`RemoteVisio.app/Contents/Library/SystemExtensions/` when a Developer ID provisioning profile is present,
signed with `../camera.entitlements` (sandbox + app group, nothing else).
