// oasis-root-key — Mike's authority root key in this Mac's Secure Enclave
// (Mike, 2026-11-02; step 3 of the identity plan, scripts/claw-authority.mjs).
//
//   oasis-root-key create <keyfile>   make the key; print its public key
//   oasis-root-key public <keyfile>   print the public key (no prompt)
//   oasis-root-key sign <keyfile>     sign the authority event on stdin
//                                     (Touch ID or the Mac password)
//
// The private key never leaves the Secure Enclave. <keyfile> holds only the
// enclave's wrapped blob: it works on this Mac alone, and each signature
// needs user presence (kSecAccessControlUserPresence), so a copy of the file
// signs nothing. The Secure Enclave holds P-256 keys only, so the root key is
// ECDSA P-256 over SHA-256; claw-authority.mjs verifies it with node:crypto.
//
// The Touch ID text comes from the event itself (kind, scope, id prefix),
// never from the caller's arguments, so a caller cannot describe one event
// and get a signature for another. `sign` refuses input that is not a
// canonical authority event. Output is one JSON line on stdout.

import CryptoKit
import Foundation
import LocalAuthentication
import Security

func fail(_ message: String, _ code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("oasis-root-key: \(message)\n".utf8))
    exit(code)
}

func emit(_ object: [String: String]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { fail("cannot write JSON") }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func accessControl() -> SecAccessControl {
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &error
    ) else { fail("cannot make the access control: \(String(describing: error?.takeRetainedValue()))") }
    return access
}

func readBlob(_ path: String) -> Data {
    guard let blob = FileManager.default.contents(atPath: path) else { fail("cannot read \(path)") }
    return blob
}

func publicKey(_ key: SecureEnclave.P256.Signing.PrivateKey) -> [String: String] {
    let spki = key.publicKey.derRepresentation
    let fingerprint = SHA256.hash(data: spki).map { String(format: "%02x", $0) }.joined().prefix(16)
    return ["alg": "p256", "public": spki.base64EncodedString(), "key": "p256:\(fingerprint)"]
}

let args = CommandLine.arguments
guard args.count == 3 else { fail("usage: oasis-root-key create|public|sign <keyfile>", 2) }
let command = args[1]
let keyPath = args[2]
guard SecureEnclave.isAvailable else { fail("this Mac has no Secure Enclave") }

switch command {
case "create":
    if FileManager.default.fileExists(atPath: keyPath) { fail("\(keyPath) exists; a root key is never replaced in place") }
    do {
        let key = try SecureEnclave.P256.Signing.PrivateKey(compactRepresentable: false, accessControl: accessControl())
        guard FileManager.default.createFile(atPath: keyPath, contents: key.dataRepresentation, attributes: [.posixPermissions: 0o600]) else {
            fail("cannot write \(keyPath)")
        }
        emit(publicKey(key))
    } catch {
        fail("cannot make the key: \(error)")
    }

case "public":
    do {
        emit(publicKey(try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: readBlob(keyPath))))
    } catch {
        fail("cannot load the key: \(error)")
    }

case "sign":
    let message = FileHandle.standardInput.readDataToEndOfFile()
    guard message.count <= 64 * 1024,
          let event = try? JSONSerialization.jsonObject(with: message) as? [String: Any],
          let kind = event["kind"] as? String, let stream = event["stream"] as? String,
          let scope = event["scope"] as? String, event["v"] as? Int == 1,
          event["sig"] == nil, event["id"] == nil
    else { fail("stdin is not an unsigned authority event", 2) }
    // The event id is sha256 of exactly these bytes (claw-authority.mjs).
    let id = SHA256.hash(data: message).map { String(format: "%02x", $0) }.joined()
    let reason = "sign \(kind) for \(scope) in \(stream), event \(id.prefix(12))"
    let context = LAContext()
    let done = DispatchSemaphore(value: 0)
    var allowed = false
    var problem: Error?
    context.evaluateAccessControl(accessControl(), operation: .useKeySign, localizedReason: reason) { ok, error in
        allowed = ok
        problem = error
        done.signal()
    }
    done.wait()
    guard allowed else { fail("not approved: \(problem.map { "\($0)" } ?? "cancelled")", 3) }
    do {
        let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: readBlob(keyPath), authenticationContext: context)
        let signature = try key.signature(for: message)
        var out = publicKey(key)
        out["id"] = id
        out["sig"] = signature.derRepresentation.base64EncodedString()
        emit(out)
    } catch {
        fail("cannot sign: \(error)")
    }

default:
    fail("usage: oasis-root-key create|public|sign <keyfile>", 2)
}
