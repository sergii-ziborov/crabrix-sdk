// Writes synthetic .crabrixprogress files for test/academy-learning-state.test.ts.
//
//   swift test/fixtures/make-progress-backup.swift test/fixtures
//
// The bytes are produced exactly as the Crabrix iOS app's LearningBackupCodec.encode
// (Crabrix/Progress/LearningProgressBackup.swift) produces them: JSONEncoder with
// sortedKeys and the default date strategy, Apple Compression COMPRESSION_ZLIB,
// CryptoKit SHA-256, the "CRABRIX-PROGRESS/1\n" magic and a big-endian UInt32 size.
// The snapshot mirrors LearningProgressSnapshot's coding keys and types and is
// normalized the way LearningProgressSnapshot.validated() normalizes it before
// encoding (sorted completed IDs, no credit for a completed lesson, sorted flashcards).
// All data is synthetic: no real learner, device or account.
import Compression
import CryptoKit
import Foundation

struct TopicMasteryRecord: Codable {
    let topic: String
    var repetitions: Int
    var easeFactor: Double
    var intervalDays: Double
    var dueAt: Date
    var correct: Int
    var incorrect: Int
    var lastSeenAt: Date?
}

struct FlashcardReviewRecord: Codable {
    let cardID: String
    let lessonID: String
    var revision: String
    var mastery: TopicMasteryRecord
}

struct LearningProgressSnapshot: Encodable {
    var schemaVersion: Int
    var id: String
    var createdAt: Date
    var deviceFamily: String
    var progressData: Data
    var completedLessonIDs: [String]
    var answers: [String: Int]
    var mastery: [String: TopicMasteryRecord]
    var flashcards: [FlashcardReviewRecord]
    var lessonResetDates: [String: Double]
    var termTrainSessions: Int
    var codeRecallSessions: Int
    var flashcardSessions: Int
    var creditedLessonIDs: [String: String] = [:]

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, id, createdAt, deviceFamily, progressData, completedLessonIDs, answers
        case mastery, flashcards, lessonResetDates, termTrainSessions, codeRecallSessions
        case flashcardSessions, creditedLessonIDs
    }

    // Same as the app: creditedLessonIDs is written only when non-empty.
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(id, forKey: .id)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(deviceFamily, forKey: .deviceFamily)
        try container.encode(progressData, forKey: .progressData)
        try container.encode(completedLessonIDs, forKey: .completedLessonIDs)
        try container.encode(answers, forKey: .answers)
        try container.encode(mastery, forKey: .mastery)
        try container.encode(flashcards, forKey: .flashcards)
        try container.encode(lessonResetDates, forKey: .lessonResetDates)
        try container.encode(termTrainSessions, forKey: .termTrainSessions)
        try container.encode(codeRecallSessions, forKey: .codeRecallSessions)
        try container.encode(flashcardSessions, forKey: .flashcardSessions)
        if !creditedLessonIDs.isEmpty {
            try container.encode(creditedLessonIDs, forKey: .creditedLessonIDs)
        }
    }

    func normalized() -> Self {
        var copy = self
        copy.completedLessonIDs.sort()
        let completed = Set(completedLessonIDs)
        copy.creditedLessonIDs = creditedLessonIDs.filter { !completed.contains($0.key) }
        copy.flashcards.sort { $0.cardID < $1.cardID }
        return copy
    }
}

enum LearningBackupCodec {
    static let maximumDecodedBytes = 4 * 1_024 * 1_024
    static let maximumEncodedBytes = 5 * 1_024 * 1_024
    private static let magic = Data("CRABRIX-PROGRESS/1\n".utf8)

    static func json(_ snapshot: LearningProgressSnapshot) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(snapshot)
    }

    static func encode(_ snapshot: LearningProgressSnapshot) throws -> Data {
        let bytes = try json(snapshot.normalized())
        precondition(bytes.count <= maximumDecodedBytes)
        var compressed = Data(count: maximumEncodedBytes)
        let count = compressed.withUnsafeMutableBytes { output in
            bytes.withUnsafeBytes { input in
                compression_encode_buffer(output.bindMemory(to: UInt8.self).baseAddress!, output.count,
                                          input.bindMemory(to: UInt8.self).baseAddress!, input.count,
                                          nil, COMPRESSION_ZLIB)
            }
        }
        precondition(count > 0)
        compressed.count = count
        var encoded = magic
        var size = UInt32(bytes.count).bigEndian
        withUnsafeBytes(of: &size) { encoded.append(contentsOf: $0) }
        encoded.append(contentsOf: SHA256.hash(data: bytes))
        encoded.append(compressed)
        precondition(encoded.count <= maximumEncodedBytes)
        return encoded
    }
}

func date(_ text: String) -> Date { ISO8601DateFormatter().date(from: text)! }

let directory = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
let reviewed = TopicMasteryRecord(topic: "ownership", repetitions: 2, easeFactor: 2.6, intervalDays: 6,
                                  dueAt: date("2026-11-26T09:30:00Z"), correct: 2, incorrect: 1,
                                  lastSeenAt: date("2026-11-20T09:00:00Z"))
let card = FlashcardReviewRecord(cardID: "ownership.card-1", lessonID: "ownership",
                                 revision: String(repeating: "ab", count: 32),
                                 mastery: TopicMasteryRecord(topic: "ownership.card-1", repetitions: 1, easeFactor: 2.5,
                                                             intervalDays: 4, dueAt: date("2026-11-24T09:30:00Z"),
                                                             correct: 1, incorrect: 0, lastSeenAt: date("2026-11-20T09:10:00Z")))
// A minimal CrabrixProgressState payload; the app decodes absent counters as 0.
let progress = Data(#"{"lessonsCompleted":5,"totalPoints":420,"version":1}"#.utf8)
let snapshot = LearningProgressSnapshot(
    schemaVersion: 1,
    id: "6F1C2D3E-4A5B-4C6D-8E7F-901A2B3C4D5E",
    createdAt: date("2026-11-20T09:30:15Z"),
    deviceFamily: "iPhone",
    progressData: progress,
    // "retired-lesson" is no longer in the Academy; "Legacy_Lesson" does not fit the
    // AI Learning State id pattern. Both are valid app IDs.
    completedLessonIDs: ["variables", "ownership", "c-what-rust-is", "c-printf-to-println", "retired-lesson", "Legacy_Lesson"],
    answers: ["variables": 2, "ownership": 1],
    mastery: ["ownership": reviewed],
    flashcards: [card],
    lessonResetDates: [:],
    termTrainSessions: 3,
    codeRecallSessions: 1,
    flashcardSessions: 2,
    // target → bridge lesson. "variables" is completed, so the app drops its credit.
    creditedLessonIDs: ["what-is-rust": "c-what-rust-is", "hello-rust": "c-printf-to-println",
                        "print-formatting": "c-printf-to-println", "variables": "c-const-by-default"]
)
try LearningBackupCodec.encode(snapshot).write(to: directory.appendingPathComponent("synthetic-v1.crabrixprogress"))

// The same backup from a future app whose snapshot schema is 2.
var newer = snapshot
newer.schemaVersion = 2
try LearningBackupCodec.encode(newer).write(to: directory.appendingPathComponent("synthetic-v2.crabrixprogress"))
print("Wrote synthetic-v1.crabrixprogress and synthetic-v2.crabrixprogress to \(directory.path)")
