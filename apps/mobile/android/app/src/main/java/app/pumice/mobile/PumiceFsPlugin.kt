package app.pumice.mobile

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.Settings
import android.util.Base64
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.IOException
import java.util.UUID
import org.json.JSONArray

/**
 * Vault file access for Pumice (docs/plan/07). Paths are vault-relative and can't escape the
 * vault.
 *
 * Vaults live in app-specific external storage (Android/data/app.pumice.mobile/files/<name>,
 * visible to file managers and USB; no permission needed), or in any folder on the device, for
 * example a synced Obsidian vault. Device folders are read with plain file access, which is much
 * faster than the Storage Access Framework for thousands of notes but needs the "all files
 * access" permission, as Obsidian does.
 */
@CapacitorPlugin(name = "PumiceFs")
class PumiceFsPlugin : Plugin() {
    private val prefs by lazy { context.getSharedPreferences("pumice", Context.MODE_PRIVATE) }
    private val appDir: File by lazy { context.getExternalFilesDir(null) ?: context.filesDir }
    private var cachedRoot: File? = null

    private fun hasAllFilesAccess() =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()

    private fun inAppStorage(dir: File) = dir.canonicalFile.parentFile == appDir.canonicalFile

    /** Device folders opened before (absolute paths). */
    private fun deviceVaults(): MutableList<String> {
        val out = mutableListOf<String>()
        val json = JSONArray(prefs.getString("deviceVaults", "[]"))
        for (i in 0 until json.length()) out.add(json.getString(i))
        return out
    }

    private fun saveDeviceVaults(paths: List<String>) =
        prefs.edit().putString("deviceVaults", JSONArray(paths).toString()).apply()

    private fun usable(dir: File) =
        dir.isDirectory && (inAppStorage(dir) || (hasAllFilesAccess() && dir.canRead()))

    /** The vault in use: the last one chosen if it is still reachable, else the default one. */
    private val root: File
        get() {
            cachedRoot?.let { return it }
            val saved = prefs.getString("current", null)?.let { File(it) }
            val dir = if (saved != null && usable(saved)) saved else File(appDir, "Pumice").apply { mkdirs() }
            cachedRoot = dir
            return dir
        }

    private fun setCurrent(dir: File) {
        prefs.edit().putString("current", dir.absolutePath).apply()
        cachedRoot = null
    }

    private fun vaultJson(dir: File) = JSObject().apply {
        put("id", dir.absolutePath)
        put("name", dir.name)
        put("location", if (inAppStorage(dir)) "In the app" else dir.absolutePath)
        put("current", dir.canonicalFile == root.canonicalFile)
        put("inApp", inAppStorage(dir))
    }

    private fun resolve(path: String): File {
        val base = root.canonicalFile
        val file = File(base, path).canonicalFile
        if (file != base && !file.path.startsWith(base.path + File.separator)) throw IOException("Path escapes the vault: $path")
        return file
    }

    private fun entry(file: File, path: String): JSObject? {
        if (!file.exists()) return null
        return JSObject().apply {
            put("path", path)
            put("kind", if (file.isDirectory) "folder" else "file")
            put("size", if (file.isDirectory) 0 else file.length())
            put("mtime", file.lastModified())
        }
    }

    private inline fun run(call: PluginCall, body: () -> JSObject?) {
        try {
            val result = body()
            if (result != null) call.resolve(result) else call.resolve()
        } catch (e: Exception) {
            call.reject(e.message ?: e.toString())
        }
    }

    @PluginMethod
    fun info(call: PluginCall) = run(call) {
        JSObject().apply {
            put("vaultName", root.name)
            put("vaultUri", root.toURI().toString())
        }
    }

    @PluginMethod
    fun listVaults(call: PluginCall) = run(call) {
        val current = root
        val dirs = (appDir.listFiles { f -> f.isDirectory && !f.name.startsWith(".") }?.toList() ?: emptyList()) +
            deviceVaults().map { File(it) }.filter { it.isDirectory }
        val all = (dirs + current).distinctBy { it.canonicalPath }.sortedBy { it.name.lowercase() }
        JSObject().apply { put("vaults", JSArray(all.map { vaultJson(it) })) }
    }

    @PluginMethod
    fun openVault(call: PluginCall) = run(call) {
        val id = call.getString("id") ?: throw IOException("Missing vault")
        val dir = File(id)
        val known = inAppStorage(dir) || deviceVaults().contains(dir.absolutePath)
        if (!known || !dir.isDirectory) throw IOException("This vault is no longer available.")
        if (!usable(dir)) throw IOException("Pumice needs access to all files to open this folder.")
        setCurrent(dir)
        null
    }

    @PluginMethod
    fun createVault(call: PluginCall) = run(call) {
        val name = (call.getString("name") ?: "").trim().replace(Regex("[\\\\/:*?\"<>|]"), "-").trim('.', ' ')
        if (name.isEmpty()) throw IOException("Give the vault a name.")
        val dir = File(appDir, name)
        if (dir.exists()) throw IOException("A vault named \"$name\" already exists.")
        if (!dir.mkdirs()) throw IOException("Could not create the vault.")
        setCurrent(dir)
        null
    }

    @PluginMethod
    fun forgetVault(call: PluginCall) = run(call) {
        val id = call.getString("id") ?: throw IOException("Missing vault")
        if (inAppStorage(File(id))) throw IOException("This vault is stored in the app. Delete its folder with a file manager to remove it.")
        saveDeviceVaults(deviceVaults().filter { it != id })
        null
    }

    /** Opens a folder on the device as vault (needs "all files access"; asks for it first). */
    @PluginMethod
    fun pickVault(call: PluginCall) {
        if (!hasAllFilesAccess()) {
            try {
                val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${context.packageName}"))
                startActivityForResult(call, intent, "allFilesResult")
            } catch (e: Exception) {
                startActivityForResult(call, Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION), "allFilesResult")
            }
            return
        }
        startActivityForResult(call, Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), "pickVaultResult")
    }

    @ActivityCallback
    private fun allFilesResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        if (!hasAllFilesAccess()) {
            call.reject("Pumice can only open folders outside the app with access to all files.")
            return
        }
        startActivityForResult(call, Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), "pickVaultResult")
    }

    @ActivityCallback
    private fun pickVaultResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            call.resolve(JSObject().apply { put("cancelled", true) })
            return
        }
        try {
            // "primary:Documents/Notes" → /storage/emulated/0/Documents/Notes
            val docId = DocumentsContract.getTreeDocumentId(uri)
            val volume = docId.substringBefore(':')
            val rel = docId.substringAfter(':', "")
            val base = if (volume.equals("primary", ignoreCase = true)) Environment.getExternalStorageDirectory() else File("/storage/$volume")
            val dir = if (rel.isEmpty()) base else File(base, rel)
            if (!dir.isDirectory || !dir.canRead()) throw IOException("Pumice can't read this folder. Choose a folder in the device's storage.")
            saveDeviceVaults((deviceVaults().filter { it != dir.absolutePath } + dir.absolutePath))
            setCurrent(dir)
            call.resolve(JSObject().apply {
                put("vaultName", dir.name)
                put("vaultUri", dir.toURI().toString())
            })
        } catch (e: Exception) {
            call.reject(e.message ?: e.toString())
        }
    }

    @PluginMethod
    fun statTree(call: PluginCall) = run(call) {
        val entries = JSArray()
        val base = root.canonicalFile
        fun walk(dir: File) {
            for (child in dir.listFiles() ?: emptyArray()) {
                if (child.name.startsWith(".") && child.name != ".pumice") continue
                val rel = child.canonicalFile.path.removePrefix(base.path + File.separator).replace(File.separatorChar, '/')
                entries.put(entry(child, rel))
                if (child.isDirectory) walk(child)
            }
        }
        walk(base)
        JSObject().apply { put("entries", entries) }
    }

    @PluginMethod
    fun stat(call: PluginCall) = run(call) {
        val path = call.getString("path") ?: ""
        JSObject().apply { put("entry", entry(resolve(path), path) ?: JSObject.NULL) }
    }

    @PluginMethod
    fun readText(call: PluginCall) = run(call) {
        JSObject().apply { put("text", resolve(call.getString("path") ?: "").readText(Charsets.UTF_8)) }
    }

    @PluginMethod
    fun readBinary(call: PluginCall) = run(call) {
        val bytes = resolve(call.getString("path") ?: "").readBytes()
        JSObject().apply { put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)) }
    }

    @PluginMethod
    fun write(call: PluginCall) = run(call) {
        val path = call.getString("path") ?: ""
        val file = resolve(path)
        val data = call.getString("text")?.toByteArray(Charsets.UTF_8)
            ?: call.getString("base64")?.let { Base64.decode(it, Base64.DEFAULT) }
            ?: throw IOException("Nothing to write")
        file.parentFile?.mkdirs()
        // Atomic: write a hidden temp file next to the target, then rename over it.
        val tmp = File(file.parentFile, ".${file.name}.${UUID.randomUUID().toString().take(8)}.tmp")
        tmp.writeBytes(data)
        if (!tmp.renameTo(file)) {
            file.delete()
            if (!tmp.renameTo(file)) throw IOException("Could not write $path")
        }
        JSObject().apply { put("entry", entry(file, path)) }
    }

    @PluginMethod
    fun rename(call: PluginCall) = run(call) {
        val from = resolve(call.getString("from") ?: "")
        val to = resolve(call.getString("to") ?: "")
        to.parentFile?.mkdirs()
        if (!from.renameTo(to)) throw IOException("Could not rename")
        null
    }

    @PluginMethod
    fun remove(call: PluginCall) = run(call) {
        val file = resolve(call.getString("path") ?: "")
        if (file.canonicalFile == root.canonicalFile) throw IOException("Refusing to delete the vault")
        if (call.getBoolean("trash", true) == true) {
            val trash = File(root, ".trash").apply { mkdirs() }
            var target = File(trash, file.name)
            var n = 1
            while (target.exists()) target = File(trash, "${++n} ${file.name}")
            if (!file.renameTo(target)) throw IOException("Could not move to trash")
        } else {
            file.deleteRecursively()
        }
        null
    }

    @PluginMethod
    fun mkdir(call: PluginCall) = run(call) {
        resolve(call.getString("path") ?: "").mkdirs()
        null
    }

    @PluginMethod
    fun share(call: PluginCall) = run(call) {
        val file = resolve(call.getString("path") ?: "")
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "*/*"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        activity.startActivity(Intent.createChooser(intent, file.name))
        null
    }
}
