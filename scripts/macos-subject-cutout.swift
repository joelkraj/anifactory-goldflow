import AppKit
import CoreImage
import Vision

guard CommandLine.arguments.count == 3 else {
    fputs("usage: macos-subject-cutout <input-image> <output-png>\n", stderr)
    exit(2)
}

let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
guard let image = NSImage(contentsOf: inputURL),
      let data = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: data),
      let cgImage = bitmap.cgImage else {
    fputs("could not decode input image\n", stderr)
    exit(1)
}

if #available(macOS 14.0, *) {
    let request = VNGenerateForegroundInstanceMaskRequest()
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
        guard let observation = request.results?.first else { throw NSError(domain: "cutout", code: 1) }
        let maskBuffer = try observation.generateScaledMaskForImage(forInstances: observation.allInstances, from: handler)
        let source = CIImage(cgImage: cgImage)
        let mask = CIImage(cvPixelBuffer: maskBuffer)
        let clear = CIImage(color: .clear).cropped(to: source.extent)
        let cutout = source.applyingFilter("CIBlendWithMask", parameters: [
            kCIInputBackgroundImageKey: clear,
            kCIInputMaskImageKey: mask
        ])
        let context = CIContext(options: [.useSoftwareRenderer: false])
        guard let output = context.createCGImage(cutout, from: source.extent) else { throw NSError(domain: "cutout", code: 2) }
        let outputRep = NSBitmapImageRep(cgImage: output)
        guard let png = outputRep.representation(using: .png, properties: [:]) else { throw NSError(domain: "cutout", code: 3) }
        try png.write(to: outputURL, options: .atomic)
    } catch {
        fputs("foreground extraction failed: \(error)\n", stderr)
        exit(1)
    }
} else {
    fputs("foreground extraction requires macOS 14 or newer\n", stderr)
    exit(1)
}
