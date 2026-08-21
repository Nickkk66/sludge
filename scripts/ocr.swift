// Sludge's OCR helper: one image in, recognized lines out as JSON.
//
// Vision reads a page crop flawlessly but silently drops paragraphs on a full
// two-page spread — small print at ~1% of image height falls below its region
// detector's comfort. So the image is recognized in tiles (each page half of a
// spread, split into vertically overlapping bands) and the results merged,
// with duplicates from the overlap removed.
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

let W = CGFloat(cg.width)
let H = CGFloat(cg.height)

struct Line { var t: String; var x: CGFloat; var y: CGFloat; var w: CGFloat; var h: CGFloat; var c: Float }

func recognize(_ image: CGImage, tile: CGRect) -> [Line] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["en-US"]
    guard (try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])) != nil else { return [] }
    var out: [Line] = []
    for obs in request.results ?? [] {
        guard let best = obs.topCandidates(1).first else { continue }
        let b = obs.boundingBox   // normalized within the tile, bottom-left origin
        out.append(Line(
            t: best.string,
            x: (tile.origin.x + b.origin.x * tile.width) / W,
            y: (tile.origin.y + (1 - b.origin.y - b.height) * tile.height) / H,
            w: b.width * tile.width / W,
            h: b.height * tile.height / H,
            c: best.confidence
        ))
    }
    return out
}

// A wide image is an open book: cut at the gutter. Each column is read in two
// vertically overlapping bands so no text line is ever sliced without a
// second, whole copy existing in the neighbouring band.
let columns: [CGRect] = W > H * 1.15
    ? [CGRect(x: 0, y: 0, width: W / 2, height: H), CGRect(x: W / 2, y: 0, width: W / 2, height: H)]
    : [CGRect(x: 0, y: 0, width: W, height: H)]

var lines: [Line] = []
for col in columns {
    let bandH = col.height * 0.56
    let bands = [
        CGRect(x: col.origin.x, y: 0, width: col.width, height: bandH),
        CGRect(x: col.origin.x, y: col.height - bandH, width: col.width, height: bandH)
    ]
    for band in bands {
        if let tile = cg.cropping(to: band) {
            lines.append(contentsOf: recognize(tile, tile: band))
        }
    }
}

// Merge: the overlap band recognizes shared lines twice; keep the better one.
var kept: [Line] = []
for line in lines.sorted(by: { $0.c > $1.c }) {
    var duplicate = false
    for other in kept {
        let dy = abs((line.y + line.h / 2) - (other.y + other.h / 2))
        if dy > min(line.h, other.h) * 0.6 { continue }
        let overlap = min(line.x + line.w, other.x + other.w) - max(line.x, other.x)
        if overlap > 0.5 * min(line.w, other.w) { duplicate = true; break }
    }
    if !duplicate { kept.append(line) }
}

var out: [[String: Any]] = []
for l in kept {
    out.append(["t": l.t, "x": l.x, "y": l.y, "w": l.w, "h": l.h, "c": l.c])
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out))
