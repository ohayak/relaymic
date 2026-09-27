import CoreGraphics
import CoreMedia
import CoreMediaIO
import CoreText
import CoreVideo
import Foundation
import IOKit.audio
import os

// Remote Visio virtual camera: a Core Media I/O camera extension that
// publishes one device with two streams. The SOURCE stream is what Zoom,
// FaceTime, Teams and QuickTime capture from; the SINK stream is where the
// Remote Visio receiver writes the decoded frames of the remote camera. The
// extension forwards sink frames to the source and shows a placeholder while
// nothing arrives. That is the pattern Apple DTS recommends (and what OBS's
// mac-camera-extension does): a sandboxed system extension can't open a
// socket to the receiver, but any process may write into a CMIO sink stream.
//
// Built with plain swiftc by the Makefile; nested in
// RemoteVisio.app/Contents/Library/SystemExtensions/ by assemble-app.sh.

// MARK: - Fixed identifiers
// Other components (the receiver's CMIO client, the installer, the app)
// depend on these exact values. Change one only together with all of them.

/// Bundle identifier of the extension; also the mach service name suffix in
/// Info.plist and the os_log subsystem.
let extensionBundleID = "com.remotevisio.app.camera"
/// Provider manufacturer and legal name.
let manufacturerName = "Remote Visio"
/// The device as video apps list it, and its model string.
let deviceName = "Remote Visio Camera"
let deviceModel = "Remote Visio Camera"
/// Device UID; the receiver finds the device by it (falls back to the name).
let deviceUID = UUID(uuidString: "7A5D8C2E-2C4B-4E6F-9A1B-3D5F7E9C1B2D")! // literal, cannot fail
/// The SOURCE stream (added first; clients also fall back to addStream order).
let sourceStreamName = "Remote Visio Camera"
let sourceStreamID = UUID(uuidString: "B1C2D3E4-F5A6-4B7C-8D9E-0F1A2B3C4D5E")! // literal, cannot fail
/// The SINK stream the receiver writes into.
let sinkStreamName = "Remote Visio Camera Sink"
let sinkStreamID = UUID(uuidString: "C2D3E4F5-A6B7-4C8D-9E0F-1A2B3C4D5E6F")! // literal, cannot fail
/// Only these signing identifiers may start the sink stream: the bare
/// receiver binary, its bundle id, and the app that wraps it.
let allowedSinkSigningIDs: Set<String> = [
    "remotevisio-receiver",
    "com.remotevisio.receiver",
    "com.remotevisio.app",
]

// MARK: - Declared format

// One format, 1080p 32BGRA at 30 fps. Declaring BGRA is what makes QuickTime
// list the device; the sink accepts NV12 ('420v') or BGRA pixel buffers of any
// size and forwards them unchanged, and the consumers scale.
let frameWidth = 1920
let frameHeight = 1080
let frameRate = 30
let frameDuration = CMTime(value: 1, timescale: CMTimeScale(frameRate))
let frameInterval = DispatchTimeInterval.nanoseconds(1_000_000_000 / frameRate)
/// The sink is polled at three times the frame rate so a frame never waits a
/// whole frame interval before it is forwarded.
let consumeInterval = DispatchTimeInterval.nanoseconds(1_000_000_000 / (3 * frameRate))
/// Sink queue: the receiver keeps exactly one frame in flight; a deeper queue
/// only adds latency to a live camera.
let sinkBufferQueueSize = 1
let sinkBuffersRequiredForStartup = 1
/// A real frame younger than this means the sink path is delivering and the
/// placeholder timer must stay out of the way (1.5 frame intervals).
let freshFrameWindow = 1.5 / Double(frameRate)
/// After this long without a frame from the receiver the last frame is
/// dropped and the placeholder comes back.
let staleFrameAge = 1.0

let logger = Logger(subsystem: extensionBundleID, category: "extension")

// MARK: - Helpers

func hostNanoseconds(_ time: CMTime) -> UInt64 {
    UInt64(max(0, time.seconds) * Double(NSEC_PER_SEC))
}

/// A copy of `buffer` whose presentation time is `pts` on the host clock. The
/// CMIO synchronizer drops frames whose PTS is not host-time based, and the
/// receiver's stamps are whatever its decoder produced, so every frame going
/// to the source stream is re-stamped here.
func restamped(_ buffer: CMSampleBuffer, at pts: CMTime) -> CMSampleBuffer? {
    let original = CMSampleBufferGetDuration(buffer)
    var timing = CMSampleTimingInfo(
        duration: original.isValid && original.seconds > 0 ? original : frameDuration,
        presentationTimeStamp: pts,
        decodeTimeStamp: .invalid)
    var copy: CMSampleBuffer?
    let status = CMSampleBufferCreateCopyWithNewTiming(
        allocator: kCFAllocatorDefault, sampleBuffer: buffer,
        sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleBufferOut: &copy)
    guard status == noErr else { return nil }
    return copy
}

// MARK: - Placeholder frame

/// One BGRA frame, rendered once with CoreGraphics and CoreText (no AppKit:
/// the extension has no window server connection) and re-sent with a fresh
/// PTS while nothing arrives from the receiver.
final class PlaceholderFrame {
    let pixelBuffer: CVPixelBuffer
    let formatDescription: CMVideoFormatDescription

    init?(width: Int, height: Int) {
        // IOSurface backing is what lets the buffer cross to the consumer
        // without a copy.
        let attributes: [CFString: Any] = [
            kCVPixelBufferWidthKey: width,
            kCVPixelBufferHeightKey: height,
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
        ]
        var pool: CVPixelBufferPool?
        guard CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes as CFDictionary, &pool) == kCVReturnSuccess,
              let pool else { return nil }
        var buffer: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &buffer) == kCVReturnSuccess,
              let buffer else { return nil }
        guard PlaceholderFrame.render(into: buffer, width: width, height: height) else { return nil }
        var description: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescriptionOut: &description) == noErr,
              let description else { return nil }
        pixelBuffer = buffer
        formatDescription = description
    }

    private static func render(into buffer: CVPixelBuffer, width: Int, height: Int) -> Bool {
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        // BGRA in memory = 32-bit little-endian ARGB for CoreGraphics. The
        // bitmap context's first row is the top of the picture, as video
        // consumers expect, and CoreText draws upright in its y-up space.
        let bitmapInfo = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
        guard let base = CVPixelBufferGetBaseAddress(buffer),
              let ctx = CGContext(data: base, width: width, height: height, bitsPerComponent: 8,
                                  bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: bitmapInfo) else {
            return false
        }
        ctx.setFillColor(CGColor(red: 0x13 / 255.0, green: 0x14 / 255.0, blue: 0x17 / 255.0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let mid = CGFloat(height) / 2
        drawCentered("Remote Visio", size: CGFloat(height) * 0.09, color: CGColor(red: 1, green: 1, blue: 1, alpha: 1),
                     baseline: mid + CGFloat(height) * 0.02, in: ctx, width: width)
        drawCentered("waiting for the remote camera…", size: CGFloat(height) * 0.035,
                     color: CGColor(red: 0.72, green: 0.72, blue: 0.74, alpha: 1),
                     baseline: mid - CGFloat(height) * 0.06, in: ctx, width: width)
        return true
    }

    private static func drawCentered(_ text: String, size: CGFloat, color: CGColor, baseline: CGFloat,
                                     in ctx: CGContext, width: Int) {
        let font = CTFontCreateUIFontForLanguage(.system, size, nil)
            ?? CTFontCreateWithName("Helvetica" as CFString, size, nil)
        let attributes: [NSAttributedString.Key: Any] = [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
        ]
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
        let bounds = CTLineGetBoundsWithOptions(line, [])
        ctx.textPosition = CGPoint(x: (CGFloat(width) - bounds.width) / 2 - bounds.origin.x, y: baseline)
        CTLineDraw(line, ctx)
    }
}

// MARK: - Device

/// Owns both stream sources and every piece of shared state. The state is
/// read and written on `queue` only; the CMIO callbacks (which arrive on the
/// provider's client queue) hop onto it.
final class ExtensionDeviceSource: NSObject, CMIOExtensionDeviceSource {
    private(set) lazy var device = CMIOExtensionDevice(
        localizedName: deviceName, deviceID: deviceUID, legacyDeviceID: deviceUID.uuidString, source: self)

    let queue = DispatchQueue(label: extensionBundleID + ".state")
    let streamFormat: CMIOExtensionStreamFormat
    private(set) lazy var sourceStreamSource = SourceStreamSource(device: self)
    private(set) lazy var sinkStreamSource = SinkStreamSource(device: self)

    // Shared state: `queue` only.
    private var sinkClient: CMIOExtensionClient?
    private var sinkStarted = false
    private var consumePending = false
    private var consumeTimer: DispatchSourceTimer?
    private var consumeErrorLogged = false
    /// Number of consumers that started the source stream; the placeholder
    /// timer runs while it is above zero.
    private var streamingCounter = 0
    private var sourceTimer: DispatchSourceTimer?
    /// The last frame forwarded from the sink, kept so a short gap in the
    /// stream repeats it instead of flashing the placeholder.
    private var lastFrame: CMSampleBuffer?
    private var lastFrameHostSeconds = 0.0
    private var framesFlowing = false
    private var underrunCount = 0
    private var placeholder: PlaceholderFrame?
    private var placeholderFailed = false
    private var sendErrorLogged = false

    override init() {
        var description: CMVideoFormatDescription?
        let status = CMVideoFormatDescriptionCreate(
            allocator: kCFAllocatorDefault, codecType: kCVPixelFormatType_32BGRA,
            width: Int32(frameWidth), height: Int32(frameHeight), extensions: nil,
            formatDescriptionOut: &description)
        guard status == noErr, let description else {
            // Nothing works without a format; better to exit so launchd's
            // log shows why than to publish a device with no streams.
            logger.fault("cannot create the video format description: \(status)")
            exit(EXIT_FAILURE)
        }
        streamFormat = CMIOExtensionStreamFormat(
            formatDescription: description, maxFrameDuration: frameDuration,
            minFrameDuration: frameDuration, validFrameDurations: nil)
        super.init()
        do {
            // Source first: clients that cannot match the stream IDs fall
            // back to this order.
            try device.addStream(sourceStreamSource.stream)
            try device.addStream(sinkStreamSource.stream)
        } catch {
            logger.fault("cannot add the streams: \(error.localizedDescription, privacy: .public)")
            exit(EXIT_FAILURE)
        }
    }

    // MARK: CMIOExtensionDeviceSource

    var availableProperties: Set<CMIOExtensionProperty> {
        [.deviceTransportType, .deviceModel]
    }

    func deviceProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionDeviceProperties {
        let props = CMIOExtensionDeviceProperties(dictionary: [:])
        if properties.contains(.deviceTransportType) {
            props.transportType = kIOAudioDeviceTransportTypeVirtual
        }
        if properties.contains(.deviceModel) {
            props.model = deviceModel
        }
        return props
    }

    func setDeviceProperties(_ deviceProperties: CMIOExtensionDeviceProperties) throws {
        // Both properties are read-only; nothing to set.
    }

    // MARK: Source stream (called on the client queue)

    func sourceStreamStarted() {
        queue.sync {
            streamingCounter += 1
            guard streamingCounter == 1 else { return }
            logger.info("source stream started")
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now(), repeating: frameInterval, leeway: .milliseconds(2))
            timer.setEventHandler { [weak self] in self?.sourceTick() }
            timer.resume()
            sourceTimer = timer
        }
    }

    func sourceStreamStopped() {
        queue.sync {
            guard streamingCounter > 0 else { return }
            streamingCounter -= 1
            guard streamingCounter == 0 else { return }
            sourceTimer?.cancel()
            sourceTimer = nil
            logger.info("source stream stopped")
        }
    }

    /// 30 Hz while a consumer is streaming. Does nothing while the sink path
    /// delivers; repeats the last real frame across a short gap; shows the
    /// placeholder once the gap is longer than `staleFrameAge`.
    private func sourceTick() {
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        if let frame = lastFrame {
            let age = now.seconds - lastFrameHostSeconds
            if age < freshFrameWindow { return }
            if age < staleFrameAge {
                if sinkStarted { underrunCount += 1 }
                if let copy = restamped(frame, at: now) { send(copy, at: now) }
                return
            }
            lastFrame = nil
            framesFlowing = false
            logger.info("no frame from the receiver for \(staleFrameAge, privacy: .public) s; showing the placeholder")
        }
        if sinkStarted { underrunCount += 1 }
        sendPlaceholder(at: now)
    }

    private func sendPlaceholder(at now: CMTime) {
        if placeholder == nil, !placeholderFailed {
            placeholder = PlaceholderFrame(width: frameWidth, height: frameHeight)
            if placeholder == nil {
                placeholderFailed = true
                logger.error("cannot render the placeholder frame; the source stays black while no frames arrive")
            }
        }
        guard let placeholder else { return }
        var timing = CMSampleTimingInfo(duration: frameDuration, presentationTimeStamp: now, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        let status = CMSampleBufferCreateForImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: placeholder.pixelBuffer, dataReady: true,
            makeDataReadyCallback: nil, refcon: nil, formatDescription: placeholder.formatDescription,
            sampleTiming: &timing, sampleBufferOut: &sample)
        guard status == noErr, let sample else {
            if !sendErrorLogged {
                sendErrorLogged = true
                logger.error("cannot wrap the placeholder frame: \(status)")
            }
            return
        }
        send(sample, at: now)
    }

    private func send(_ sample: CMSampleBuffer, at pts: CMTime) {
        sourceStreamSource.stream.send(sample, discontinuity: [], hostTimeInNanoseconds: hostNanoseconds(pts))
    }

    // MARK: Sink stream (called on the client queue)

    func authorizeSinkClient(_ client: CMIOExtensionClient) -> Bool {
        let signingID = client.signingID ?? ""
        guard allowedSinkSigningIDs.contains(signingID) else {
            logger.error("refused sink client \(signingID.isEmpty ? "<unsigned>" : signingID, privacy: .public) (pid \(client.pid))")
            return false
        }
        // One writer at a time. Start and stop arrive per client and the stop
        // carries no client, so a second receiver taking the sink over would
        // have the first one's stop tear the session down under it. It is
        // refused instead (its CMIODeviceStartStream fails with a permissions
        // error, which the receiver reports) and can try again once the first
        // has stopped.
        let accepted: Bool = queue.sync {
            if sinkStarted, let current = sinkClient, current.clientID != client.clientID {
                logger.error("refused sink client pid \(client.pid): pid \(current.pid) is streaming into the sink")
                return false
            }
            sinkClient = client
            return true
        }
        guard accepted else { return false }
        logger.info("sink client \(signingID, privacy: .public) (pid \(client.pid)) authorized")
        return true
    }

    func sinkStreamStarted() throws {
        try queue.sync {
            guard let client = sinkClient else {
                throw NSError(domain: extensionBundleID, code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "the sink stream was started without an authorized client",
                ])
            }
            sinkStarted = true
            consumePending = false
            consumeErrorLogged = false
            logger.info("sink stream started by pid \(client.pid)")
            consumeTimer?.cancel() // a start without a stop in between must not leave two timers running
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now(), repeating: consumeInterval, leeway: .milliseconds(1))
            timer.setEventHandler { [weak self] in self?.consumeTick() }
            timer.resume()
            consumeTimer = timer
        }
    }

    func sinkStreamStopped() {
        queue.sync {
            consumeTimer?.cancel()
            consumeTimer = nil
            sinkStarted = false
            sinkClient = nil
            // The receiver is gone: back to the placeholder right away rather
            // than repeating a stale picture for a second.
            lastFrame = nil
            framesFlowing = false
            logger.info("sink stream stopped")
        }
    }

    /// One consume request at a time: the completion may be delivered
    /// asynchronously, and stacking requests would deliver frames out of
    /// order. `hasMoreSampleBuffers` re-arms without waiting for the timer.
    private func consumeTick() {
        guard sinkStarted, !consumePending, let client = sinkClient else { return }
        consumePending = true
        sinkStreamSource.stream.consumeSampleBuffer(from: client) { [weak self] buffer, sequence, _, hasMore, error in
            guard let self else { return }
            // async, never sync: the completion may run inline on our queue.
            self.queue.async {
                self.consumed(buffer, sequence: sequence, hasMore: hasMore, error: error, from: client)
            }
        }
    }

    private func consumed(_ buffer: CMSampleBuffer?, sequence: UInt64, hasMore: Bool, error: Error?,
                          from client: CMIOExtensionClient) {
        consumePending = false
        // A completion that lands after stop, or for a client that was replaced.
        guard sinkStarted, sinkClient?.clientID == client.clientID else { return }
        if let error {
            if !consumeErrorLogged {
                consumeErrorLogged = true
                logger.error("sink consume failed: \(error.localizedDescription, privacy: .public)")
            }
            return
        }
        guard let buffer else { return }
        consumeErrorLogged = false
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        guard let frame = restamped(buffer, at: now) else { return }
        lastFrame = frame
        lastFrameHostSeconds = now.seconds
        if !framesFlowing {
            framesFlowing = true
            logger.info("frames arriving from the receiver")
        }
        if streamingCounter > 0 {
            send(frame, at: now)
        }
        sinkStreamSource.stream.notifyScheduledOutputChanged(
            CMIOExtensionScheduledOutput(sequenceNumber: sequence, hostTimeInNanoseconds: hostNanoseconds(now)))
        if hasMore { consumeTick() }
    }

    var currentUnderrunCount: Int {
        queue.sync { underrunCount }
    }
}

// MARK: - Streams

/// The stream video apps capture from.
final class SourceStreamSource: NSObject, CMIOExtensionStreamSource {
    private(set) lazy var stream = CMIOExtensionStream(
        localizedName: sourceStreamName, streamID: sourceStreamID, direction: .source, clockType: .hostTime, source: self)
    private unowned let device: ExtensionDeviceSource

    init(device: ExtensionDeviceSource) {
        self.device = device
        super.init()
    }

    var formats: [CMIOExtensionStreamFormat] { [device.streamFormat] }

    var availableProperties: Set<CMIOExtensionProperty> {
        [.streamActiveFormatIndex, .streamFrameDuration]
    }

    func streamProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionStreamProperties {
        let props = CMIOExtensionStreamProperties(dictionary: [:])
        if properties.contains(.streamActiveFormatIndex) { props.activeFormatIndex = 0 }
        if properties.contains(.streamFrameDuration) { props.frameDuration = frameDuration }
        return props
    }

    func setStreamProperties(_ streamProperties: CMIOExtensionStreamProperties) throws {
        // One format at one rate: accept silently so clients that set the
        // active format before starting are not refused.
    }

    func authorizedToStartStream(for client: CMIOExtensionClient) -> Bool {
        logger.info("source client \(client.signingID ?? "<unsigned>", privacy: .public) (pid \(client.pid))")
        return true
    }

    func startStream() throws { device.sourceStreamStarted() }
    func stopStream() throws { device.sourceStreamStopped() }
}

/// The stream the Remote Visio receiver writes decoded frames into.
final class SinkStreamSource: NSObject, CMIOExtensionStreamSource {
    private(set) lazy var stream = CMIOExtensionStream(
        localizedName: sinkStreamName, streamID: sinkStreamID, direction: .sink, clockType: .hostTime, source: self)
    private unowned let device: ExtensionDeviceSource

    init(device: ExtensionDeviceSource) {
        self.device = device
        super.init()
    }

    var formats: [CMIOExtensionStreamFormat] { [device.streamFormat] }

    var availableProperties: Set<CMIOExtensionProperty> {
        [.streamActiveFormatIndex, .streamFrameDuration, .streamSinkBufferQueueSize,
         .streamSinkBuffersRequiredForStartup, .streamSinkBufferUnderrunCount, .streamSinkEndOfData]
    }

    func streamProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionStreamProperties {
        let props = CMIOExtensionStreamProperties(dictionary: [:])
        if properties.contains(.streamActiveFormatIndex) { props.activeFormatIndex = 0 }
        if properties.contains(.streamFrameDuration) { props.frameDuration = frameDuration }
        if properties.contains(.streamSinkBufferQueueSize) { props.sinkBufferQueueSize = sinkBufferQueueSize }
        if properties.contains(.streamSinkBuffersRequiredForStartup) {
            props.sinkBuffersRequiredForStartup = sinkBuffersRequiredForStartup
        }
        if properties.contains(.streamSinkBufferUnderrunCount) { props.sinkBufferUnderrunCount = device.currentUnderrunCount }
        if properties.contains(.streamSinkEndOfData) { props.sinkEndOfData = 0 }
        return props
    }

    func setStreamProperties(_ streamProperties: CMIOExtensionStreamProperties) throws {
        // The queue depth and format are fixed; accept silently.
    }

    func authorizedToStartStream(for client: CMIOExtensionClient) -> Bool {
        device.authorizeSinkClient(client)
    }

    func startStream() throws { try device.sinkStreamStarted() }
    func stopStream() throws { device.sinkStreamStopped() }
}

// MARK: - Provider

final class ExtensionProviderSource: NSObject, CMIOExtensionProviderSource {
    private(set) lazy var provider = CMIOExtensionProvider(source: self, clientQueue: clientQueue)
    private let clientQueue: DispatchQueue?
    private let deviceSource = ExtensionDeviceSource()

    init(clientQueue: DispatchQueue?) {
        self.clientQueue = clientQueue
        super.init()
        do {
            try provider.addDevice(deviceSource.device)
        } catch {
            logger.fault("cannot add the device: \(error.localizedDescription, privacy: .public)")
            exit(EXIT_FAILURE)
        }
    }

    func connect(to client: CMIOExtensionClient) throws {
        logger.info("client connected: \(client.signingID ?? "<unsigned>", privacy: .public) (pid \(client.pid))")
    }

    func disconnect(from client: CMIOExtensionClient) {
        logger.info("client disconnected: \(client.signingID ?? "<unsigned>", privacy: .public) (pid \(client.pid))")
    }

    var availableProperties: Set<CMIOExtensionProperty> {
        [.providerManufacturer]
    }

    func providerProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionProviderProperties {
        let props = CMIOExtensionProviderProperties(dictionary: [:])
        if properties.contains(.providerManufacturer) {
            props.manufacturer = manufacturerName
        }
        return props
    }

    func setProviderProperties(_ providerProperties: CMIOExtensionProviderProperties) throws {
        // Read-only.
    }
}

// MARK: - Entry point

let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
logger.info("Remote Visio camera extension \(version, privacy: .public) starting")
let providerSource = ExtensionProviderSource(clientQueue: nil)
CMIOExtensionProvider.startService(provider: providerSource.provider)
CFRunLoopRun()
