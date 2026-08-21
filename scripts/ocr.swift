// Sludge's OCR helper: one image in, recognized lines out as JSON.
// Uses Apple's Vision framework — on-device, no network, and markedly better
// on book scans than the open-source engines.
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write("usage: sludge-ocr <image>\n".data(using: .utf8)!)
    exit(2)
}
guard let img = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("unreadable image\n".data(using: .utf8)!)
    exit(3)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["en-US"]

do {
    try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
} catch {
    FileHandle.standardError.write("vision failed: \(error)\n".data(using: .utf8)!)
    exit(4)
}

// Vision boxes are normalized with a bottom-left origin; emit top-left.
var lines: [[String: Any]] = []
for obs in request.results ?? [] {
    guard let best = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox
    lines.append([
        "t": best.string,
        "x": b.origin.x,
        "y": 1 - b.origin.y - b.size.height,
        "w": b.size.width,
        "h": b.size.height,
        "c": best.confidence
    ])
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: lines))
