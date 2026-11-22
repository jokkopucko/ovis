import CryptoKit
import Foundation
import Security
import XCTest
@testable import OvisPushCore

final class PushKeyStoreTests: XCTestCase {
    private final class Store {
        var data: Data?
        var removals = 0
        var creations = 0
        var readFailure: PushKeyStore.Failure?
        var importFailure: CryptoKitError?
        var deleteFailure: PushKeyStore.Failure?

        init(_ data: Data? = nil) { self.data = data }

        func read() throws -> PushKeys? {
            if let failure = readFailure { throw failure }
            return try data.map {
                try PushKeyStore.decode($0) { bytes in
                    if let failure = self.importFailure { throw failure }
                    return try P256.KeyAgreement.PrivateKey(rawRepresentation: bytes)
                }
            }
        }

        func remove() throws {
            if let failure = deleteFailure { throw failure }
            removals += 1
            data = nil
        }

        func create() throws -> PushKeys {
            creations += 1
            let keys = try PushKeys.generate()
            data = keys.privateKey.rawRepresentation + keys.auth
            return keys
        }

        func getOrCreate() throws -> PushKeys {
            try PushKeyStore.getOrCreate(read: read, remove: remove, create: create)
        }
    }

    func testReplacesWrongLengthItem() throws {
        let store = Store(Data([1, 2, 3]))
        let recovered = try store.getOrCreate()
        XCTAssertEqual(store.removals, 1)
        XCTAssertEqual(store.creations, 1)
        XCTAssertEqual(try store.read()?.publicPoint, recovered.publicPoint)
        XCTAssertEqual(try store.read()?.auth, recovered.auth)
    }

    func testReplacesInvalidPrivateKey() throws {
        let store = Store(Data(repeating: 0, count: 48))
        let recovered = try store.getOrCreate()
        XCTAssertEqual(store.removals, 1)
        XCTAssertEqual(store.creations, 1)
        XCTAssertEqual(try store.read()?.publicPoint, recovered.publicPoint)
    }

    func testKeepsHealthyKeys() throws {
        let original = try PushKeys.generate()
        let store = Store(original.privateKey.rawRepresentation + original.auth)
        let reused = try store.getOrCreate()
        XCTAssertEqual(reused.publicPoint, original.publicPoint)
        XCTAssertEqual(reused.auth, original.auth)
        XCTAssertEqual(store.creations, 0)
        XCTAssertEqual(store.removals, 0)
    }

    func testScalarOrderBoundary() throws {
        let order = Data([
            0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00,
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84,
            0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51
        ])
        let store = Store(order + Data(repeating: 1, count: 16))
        XCTAssertThrowsError(try store.read())
        _ = try store.getOrCreate()
        XCTAssertEqual(store.removals, 1)
        XCTAssertEqual(store.creations, 1)
        var largest = order
        largest[31] -= 1
        let valid = Store(largest + Data(repeating: 1, count: 16))
        XCTAssertEqual(try valid.getOrCreate().privateKey.rawRepresentation, largest)
        XCTAssertEqual(valid.removals, 0)
        XCTAssertEqual(valid.creations, 0)
    }

    func testCreatesMissingKeysWithoutDeleting() throws {
        let store = Store()
        _ = try store.getOrCreate()
        XCTAssertEqual(store.creations, 1)
        XCTAssertEqual(store.removals, 0)
    }

    func testCryptoImportFailureDoesNotDeleteKeys() throws {
        let original = try PushKeys.generate()
        let data = original.privateKey.rawRepresentation + original.auth
        let store = Store(data)
        store.importFailure = .underlyingCoreCryptoError(error: -1)
        XCTAssertThrowsError(try store.read()) { XCTAssertTrue($0 is CryptoKitError) }
        XCTAssertThrowsError(try store.getOrCreate()) { XCTAssertTrue($0 is CryptoKitError) }
        XCTAssertEqual(store.data, data)
        XCTAssertEqual(store.removals, 0)
        XCTAssertEqual(store.creations, 0)
    }

    func testReadDoesNotRepairDamage() throws {
        let damaged = Data([1])
        let store = Store(damaged)
        XCTAssertThrowsError(try store.read())
        XCTAssertEqual(store.data, damaged)
        XCTAssertEqual(store.creations, 0)
        XCTAssertEqual(store.removals, 0)
    }

    func testLockedKeychainDoesNotDeleteKeys() throws {
        let store = Store(Data([1]))
        store.readFailure = .keychain(errSecInteractionNotAllowed)
        XCTAssertThrowsError(try store.getOrCreate())
        XCTAssertEqual(store.creations, 0)
        XCTAssertEqual(store.removals, 0)
    }

    func testFailedDeletionDoesNotCreateKeys() throws {
        let store = Store(Data([1]))
        store.deleteFailure = .keychain(errSecMissingEntitlement)
        XCTAssertThrowsError(try store.getOrCreate())
        XCTAssertEqual(store.creations, 0)
    }
}
