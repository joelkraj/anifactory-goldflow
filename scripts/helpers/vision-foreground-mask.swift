#!/usr/bin/env swift

import CoreImage
import Foundation
import ImageIO
import Vision

enum MaskError: Error, CustomStringConvertible {
    case usage
    case unreadableImage(String)
    case missingObservation
    case emptyInstances

    var description: String {
        switch self {
        case .usage:
            return "Usage: vision-foreground-mask.swift <input-image> <output-mask.png>"
        case .unreadableImage(let path):
            return "Unable to read image: \(path)"
        case .missingObservation:
            return "Vision did not return a foreground-mask observation."
        case .emptyInstances:
            return "Vision did not detect any foreground instances."
        }
    }
}

func loadImage(at url: URL) throws -> CGImage {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw MaskError.unreadableImage(url.path)
    }
    return image
}

do {
    guard CommandLine.arguments.count == 3 else { throw MaskError.usage }
    let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
    let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
    let image = try loadImage(at: inputURL)
    let request = VNGenerateForegroundInstanceMaskRequest()
    let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
    try handler.perform([request])
    guard let observation = request.results?.first else { throw MaskError.missingObservation }
    guard !observation.allInstances.isEmpty else { throw MaskError.emptyInstances }
    let maskBuffer = try observation.generateScaledMaskForImage(
        forInstances: observation.allInstances,
        from: handler
    )
    let maskImage = CIImage(cvPixelBuffer: maskBuffer)
    let context = CIContext(options: [.useSoftwareRenderer: false])
    try FileManager.default.createDirectory(
        at: outputURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    try context.writePNGRepresentation(
        of: maskImage,
        to: outputURL,
        format: .L8,
        colorSpace: CGColorSpaceCreateDeviceGray()
    )
    let result: [String: Any] = [
        "status": "passed",
        "input_path": inputURL.path,
        "output_path": outputURL.path,
        "instance_count": observation.allInstances.count,
        "width": CVPixelBufferGetWidth(maskBuffer),
        "height": CVPixelBufferGetHeight(maskBuffer),
    ]
    let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
    print(String(decoding: data, as: UTF8.self))
} catch {
    let message = error is MaskError ? String(describing: error) : error.localizedDescription
    let result: [String: Any] = ["status": "failed", "error": message]
    if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
        FileHandle.standardError.write(data)
        FileHandle.standardError.write(Data("\n".utf8))
    }
    exit(1)
}
