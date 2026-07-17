import AppKit
import Foundation

let arguments = Array(CommandLine.arguments.dropFirst())

guard !arguments.isEmpty, arguments.count.isMultiple(of: 2) else {
    FileHandle.standardError.write(Data("usage: rasterize-svg.swift <input.svg> <output.png> [...]\n".utf8))
    exit(2)
}

for index in stride(from: 0, to: arguments.count, by: 2) {
    let inputURL = URL(fileURLWithPath: arguments[index])
    let outputURL = URL(fileURLWithPath: arguments[index + 1])

    guard let image = NSImage(contentsOf: inputURL) else {
        FileHandle.standardError.write(Data("unable to load SVG: \(inputURL.path)\n".utf8))
        exit(1)
    }

    let width = Int(image.size.width.rounded())
    let height = Int(image.size.height.rounded())
    guard width > 0, height > 0 else {
        FileHandle.standardError.write(Data("invalid SVG size: \(inputURL.path)\n".utf8))
        exit(1)
    }

    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bitmapFormat: [],
        bytesPerRow: 0,
        bitsPerPixel: 0
    ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        FileHandle.standardError.write(Data("unable to allocate bitmap: \(inputURL.path)\n".utf8))
        exit(1)
    }

    bitmap.size = NSSize(width: width, height: height)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    context.cgContext.clear(CGRect(x: 0, y: 0, width: width, height: height))
    image.draw(
        in: NSRect(x: 0, y: 0, width: width, height: height),
        from: NSRect(origin: .zero, size: image.size),
        operation: .sourceOver,
        fraction: 1,
        respectFlipped: true,
        hints: [.interpolation: NSImageInterpolation.high]
    )
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()

    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        FileHandle.standardError.write(Data("unable to encode PNG: \(inputURL.path)\n".utf8))
        exit(1)
    }

    do {
        try png.write(to: outputURL, options: .atomic)
    } catch {
        FileHandle.standardError.write(Data("unable to write PNG: \(outputURL.path): \(error)\n".utf8))
        exit(1)
    }
}
