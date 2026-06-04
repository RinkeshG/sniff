// macOS Vision OCR. Reads one or more image paths and prints the recognized
// text for each, delimited by markers, so a single process can OCR a whole
// product gallery (amortizing startup). Compile:
//   swiftc -O scripts/ocr.swift -o scripts/bin/ocrtool
import Vision
import Foundation
import AppKit

for path in CommandLine.arguments.dropFirst() {
  print("@@@FILE@@@\(path)")
  if let img = NSImage(contentsOfFile: path),
     let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
    let req = VNRecognizeTextRequest { (r, _) in
      for o in (r.results as? [VNRecognizedTextObservation]) ?? [] {
        if let t = o.topCandidates(1).first { print(t.string) }
      }
    }
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
  }
  print("@@@END@@@")
}
