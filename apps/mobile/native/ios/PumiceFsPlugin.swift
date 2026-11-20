import Capacitor
import Foundation
import UniformTypeIdentifiers

/// Vault file access for Pumice (docs/plan/07). Paths are vault-relative and must stay inside
/// the vault. The vault is the app's Documents/Pumice folder (visible in the Files app) or a
/// folder the user picked, kept through a security-scoped bookmark.
@objc(PumiceFsPlugin)
public class PumiceFsPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "PumiceFsPlugin"
    public let jsName = "PumiceFs"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickVault", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "statTree", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readBinary", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rename", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mkdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise),
    ]

    private let fm = FileManager.default
    private let bookmarkKey = "pumice.vaultBookmark"
    private var root: URL?
    private var pendingPick: CAPPluginCall?

    // MARK: vault location

    private func vaultRoot() throws -> URL {
        if let root { return root }
        if let data = UserDefaults.standard.data(forKey: bookmarkKey) {
            var stale = false
            if let url = try? URL(resolvingBookmarkData: data, bookmarkDataIsStale: &stale), url.startAccessingSecurityScopedResource() {
                root = url
                return url
            }
        }
        let docs = try fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let url = docs.appendingPathComponent("Pumice", isDirectory: true)
        try fm.createDirectory(at: url, withIntermediateDirectories: true)
        root = url
        return url
    }

    /// Resolves a vault-relative path, refusing anything that escapes the vault.
    private func resolve(_ path: String) throws -> URL {
        let base = try vaultRoot().standardizedFileURL
        let url = base.appendingPathComponent(path).standardizedFileURL
        guard url.path == base.path || url.path.hasPrefix(base.path + "/") else {
            throw NSError(domain: "PumiceFs", code: 1, userInfo: [NSLocalizedDescriptionKey: "Path escapes the vault: \(path)"])
        }
        return url
    }

    private func entry(_ url: URL, _ path: String) -> [String: Any]? {
        guard let attrs = try? fm.attributesOfItem(atPath: url.path) else { return nil }
        let isDir = (attrs[.type] as? FileAttributeType) == .typeDirectory
        let mtime = ((attrs[.modificationDate] as? Date) ?? Date()).timeIntervalSince1970 * 1000
        return ["path": path, "kind": isDir ? "folder" : "file", "size": isDir ? 0 : (attrs[.size] as? Int ?? 0), "mtime": Int(mtime)]
    }

    private func run(_ call: CAPPluginCall, _ body: () throws -> [String: Any]?) {
        do {
            if let result = try body() { call.resolve(result) } else { call.resolve() }
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func info(_ call: CAPPluginCall) {
        run(call) {
            let url = try vaultRoot()
            return ["vaultName": url.lastPathComponent, "vaultUri": url.absoluteString]
        }
    }

    @objc func pickVault(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
            picker.delegate = self
            self.pendingPick = call
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pendingPick, let url = urls.first else { return }
        pendingPick = nil
        guard url.startAccessingSecurityScopedResource() else { return call.reject("No access to that folder") }
        do {
            let data = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
            UserDefaults.standard.set(data, forKey: bookmarkKey)
            root?.stopAccessingSecurityScopedResource()
            root = url
            call.resolve(["vaultName": url.lastPathComponent, "vaultUri": url.absoluteString])
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pendingPick?.resolve(["cancelled": true])
        pendingPick = nil
    }

    // MARK: files

    @objc func statTree(_ call: CAPPluginCall) {
        run(call) {
            let base = try vaultRoot()
            var entries: [[String: Any]] = []
            let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
            guard let walker = fm.enumerator(at: base, includingPropertiesForKeys: keys) else { return ["entries": entries] }
            for case let url as URL in walker {
                let rel = String(url.standardizedFileURL.path.dropFirst(base.standardizedFileURL.path.count + 1))
                let values = try? url.resourceValues(forKeys: Set(keys))
                let isDir = values?.isDirectory ?? false
                // Hidden folders are skipped, except the vault configuration.
                if url.lastPathComponent.hasPrefix(".") && url.lastPathComponent != ".pumice" {
                    if isDir { walker.skipDescendants() }
                    continue
                }
                let mtime = (values?.contentModificationDate ?? Date()).timeIntervalSince1970 * 1000
                entries.append(["path": rel, "kind": isDir ? "folder" : "file", "size": isDir ? 0 : (values?.fileSize ?? 0), "mtime": Int(mtime)])
            }
            return ["entries": entries]
        }
    }

    @objc func stat(_ call: CAPPluginCall) {
        run(call) {
            let path = call.getString("path") ?? ""
            return ["entry": entry(try resolve(path), path) ?? NSNull()]
        }
    }

    @objc func readText(_ call: CAPPluginCall) {
        run(call) { ["text": try String(contentsOf: try resolve(call.getString("path") ?? ""), encoding: .utf8)] }
    }

    @objc func readBinary(_ call: CAPPluginCall) {
        run(call) { ["base64": try Data(contentsOf: try resolve(call.getString("path") ?? "")).base64EncodedString()] }
    }

    @objc func write(_ call: CAPPluginCall) {
        run(call) {
            let path = call.getString("path") ?? ""
            let url = try resolve(path)
            let data: Data
            if let text = call.getString("text") { data = Data(text.utf8) }
            else if let b64 = call.getString("base64"), let d = Data(base64Encoded: b64) { data = d }
            else { throw NSError(domain: "PumiceFs", code: 2, userInfo: [NSLocalizedDescriptionKey: "Nothing to write"]) }
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic) // temp file + rename
            return ["entry": entry(url, path) ?? NSNull()]
        }
    }

    @objc func rename(_ call: CAPPluginCall) {
        run(call) {
            let from = try resolve(call.getString("from") ?? "")
            let to = try resolve(call.getString("to") ?? "")
            try fm.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
            try fm.moveItem(at: from, to: to)
            return nil
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        run(call) {
            let path = call.getString("path") ?? ""
            let url = try resolve(path)
            guard url.standardizedFileURL != (try vaultRoot()).standardizedFileURL else {
                throw NSError(domain: "PumiceFs", code: 3, userInfo: [NSLocalizedDescriptionKey: "Refusing to delete the vault"])
            }
            if call.getBool("trash") ?? true {
                let trash = try resolve(".trash")
                try fm.createDirectory(at: trash, withIntermediateDirectories: true)
                var target = trash.appendingPathComponent(url.lastPathComponent)
                var n = 1
                while fm.fileExists(atPath: target.path) {
                    n += 1
                    target = trash.appendingPathComponent("\(n) \(url.lastPathComponent)")
                }
                try fm.moveItem(at: url, to: target)
            } else {
                try fm.removeItem(at: url)
            }
            return nil
        }
    }

    @objc func mkdir(_ call: CAPPluginCall) {
        run(call) {
            try fm.createDirectory(at: try resolve(call.getString("path") ?? ""), withIntermediateDirectories: true)
            return nil
        }
    }

    @objc func share(_ call: CAPPluginCall) {
        guard let url = try? resolve(call.getString("path") ?? "") else { return call.reject("Bad path") }
        DispatchQueue.main.async {
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            self.bridge?.viewController?.present(sheet, animated: true)
            call.resolve()
        }
    }
}
