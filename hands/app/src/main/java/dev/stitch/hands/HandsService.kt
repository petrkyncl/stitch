package dev.stitch.hands

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Reads the screen and acts on it for the Stitch agent on the computer.
 * Tiny HTTP server on the phone's loopback; the computer reaches it through `adb forward tcp:7912 tcp:7912`.
 */
class HandsService : AccessibilityService() {

    private var server: ServerSocket? = null
    private val overlay by lazy { Overlay(this) }

    // Nodes from the last /tree call, addressed by index. `gen` tells the caller which tree an id belongs to.
    @Volatile private var nodes: List<AccessibilityNodeInfo> = emptyList()
    @Volatile private var gen = 0

    override fun onServiceConnected() {
        super.onServiceConnected()
        thread(name = "stitch-hands", isDaemon = true) { serve() }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val type = event?.eventType ?: return
        // The live boxes follow the screen; a scroll or a new screen also drops the "about to tap" marker.
        overlay.changed(moved = type == AccessibilityEvent.TYPE_VIEW_SCROLLED || type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED)
    }
    override fun onInterrupt() {}

    override fun onDestroy() {
        overlay.detach()
        runCatching { server?.close() }
        super.onDestroy()
    }

    private fun serve() {
        val socket = ServerSocket(PORT, 16, InetAddress.getByName("127.0.0.1"))
        server = socket
        while (!socket.isClosed) {
            val client = runCatching { socket.accept() }.getOrNull() ?: break
            thread(isDaemon = true) { handle(client) }
        }
    }

    private fun handle(client: Socket) = client.use { s ->
        val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.UTF_8))
        val requestLine = reader.readLine() ?: return
        val path = requestLine.split(" ").getOrNull(1) ?: "/"
        var length = 0
        while (true) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) break
            if (line.startsWith("Content-Length:", ignoreCase = true)) length = line.substringAfter(":").trim().toIntOrNull() ?: 0
        }
        val bodyChars = CharArray(length)
        var read = 0
        while (read < length) {
            val n = reader.read(bodyChars, read, length - read)
            if (n < 0) break
            read += n
        }
        val body = if (length > 0) runCatching { JSONObject(String(bodyChars, 0, read)) }.getOrDefault(JSONObject()) else JSONObject()

        val out = s.getOutputStream()
        if (path.startsWith("/icon")) {
            val png = runCatching { icon(path.substringAfter("pkg=", "").substringBefore("&")) }.getOrNull()
            val head = if (png != null) "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: ${png.size}\r\nConnection: close\r\n\r\n"
                       else "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            out.write(head.toByteArray())
            if (png != null) out.write(png)
            out.flush()
            return
        }
        val result = runCatching { route(path, body) }.getOrElse { JSONObject().put("ok", false).put("error", it.message ?: it.javaClass.simpleName) }
        val bytes = result.toString().toByteArray(Charsets.UTF_8)
        out.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
        out.write(bytes)
        out.flush()
    }

    private fun route(path: String, body: JSONObject): JSONObject = when (path.substringBefore("?")) {
        // Live boxes on or off; a bold box around the element the agent is about to use. Screen coordinates.
        "/overlay" -> {
            if (body.has("live")) overlay.setLive(body.optBoolean("live"))
            if (body.has("target")) {
                val a = body.optJSONArray("target")
                val rect = a?.let { android.graphics.RectF(it.getDouble(0).toFloat(), it.getDouble(1).toFloat(), it.getDouble(2).toFloat(), it.getDouble(3).toFloat()) }
                overlay.target(rect, body.optLong("ms", 1600))
            }
            JSONObject().put("ok", true).put("live", overlay.live)
        }
        "/ping" -> JSONObject().put("ok", true)
        "/tree" -> tree(path.substringAfter("pkg=", "").substringBefore("&"))
        "/click" -> click(body)
        "/settext" -> setText(body)
        "/tap" -> JSONObject().put("ok", tapAt(body.getDouble("x").toFloat(), body.getDouble("y").toFloat()))
        "/swipe" -> JSONObject().put("ok", swipe(body))
        "/global" -> global(body.optString("action"))
        "/launch" -> launch(body.optString("pkg"))
        "/device" -> device()
        "/node" -> nodeAction(body)
        "/apps" -> apps()
        "/ime" -> {
            val kb = StitchKeyboard.instance
            JSONObject().put("ok", true).put("installed", kb != null).put("ready", kb?.ready == true)
        }
        "/ime/type" -> {
            val kb = StitchKeyboard.instance ?: error("Stitch keyboard is not the active keyboard")
            if (!kb.ready) error("no input field is focused")
            JSONObject().put("ok", kb.type(body.optString("text"), body.optBoolean("replace", true), body.optBoolean("human", false)))
        }
        "/ime/enter" -> {
            val kb = StitchKeyboard.instance ?: error("Stitch keyboard is not the active keyboard")
            JSONObject().put("ok", kb.enter())
        }
        else -> JSONObject().put("ok", false).put("error", "unknown path $path")
    }

    // The window of the requested app when it is on screen, otherwise the active window
    // (an open notification shade or a dialog would otherwise hide the app behind it).
    private fun rootFor(pkg: String): AccessibilityNodeInfo? {
        if (pkg.isNotEmpty()) {
            for (w in windows) {
                val r = w.root ?: continue
                if (r.packageName?.toString() == pkg) return r
            }
        }
        return rootInActiveWindow
    }

    private fun tree(pkg: String): JSONObject {
        val root = rootFor(pkg) ?: return JSONObject().put("ok", false).put("error", "no active window")
        val list = ArrayList<AccessibilityNodeInfo>(256)
        val arr = JSONArray()
        val rect = Rect()
        fun walk(n: AccessibilityNodeInfo?) {
            if (n == null) return
            n.getBoundsInScreen(rect)
            if (rect.width() > 0 && rect.height() > 0 && n.isVisibleToUser) {
                val o = JSONObject()
                    .put("id", list.size)
                    .put("text", n.text?.toString() ?: "")
                    .put("desc", n.contentDescription?.toString() ?: "")
                    .put("rid", n.viewIdResourceName ?: "")
                    .put("cls", n.className?.toString()?.substringAfterLast('.') ?: "")
                    .put("pkg", n.packageName?.toString() ?: "")
                    .put("clickable", n.isClickable)
                    .put("editable", n.isEditable)
                    .put("scrollable", n.isScrollable)
                    .put("checked", n.isChecked)
                    .put("selected", n.isSelected)
                    .put("focused", n.isFocused)
                    .put("bounds", JSONArray(listOf(rect.left, rect.top, rect.right, rect.bottom)))
                list.add(n)
                arr.put(o)
            }
            for (i in 0 until n.childCount) walk(n.getChild(i))
        }
        walk(root)
        nodes = list
        gen += 1
        return JSONObject().put("ok", true).put("gen", gen).put("pkg", root.packageName?.toString() ?: "").put("nodes", arr)
    }

    private fun nodeFor(body: JSONObject): AccessibilityNodeInfo {
        if (body.optInt("gen", gen) != gen) error("stale tree, call /tree again")
        return nodes.getOrNull(body.getInt("id")) ?: error("no node ${body.optInt("id")}")
    }

    // Click the node itself or its nearest clickable parent; fall back to a tap gesture on its centre.
    private fun click(body: JSONObject): JSONObject {
        val node = nodeFor(body)
        var target: AccessibilityNodeInfo? = node
        while (target != null && !target.isClickable) target = target.parent
        if (target != null && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return JSONObject().put("ok", true).put("via", "action")
        val r = Rect().also { node.getBoundsInScreen(it) }
        return JSONObject().put("ok", tapAt(r.exactCenterX(), r.exactCenterY())).put("via", "gesture")
    }

    // The app's launcher icon as a 96 px PNG, for the studio's app picker.
    private fun icon(pkg: String): ByteArray {
        val drawable = packageManager.getApplicationIcon(pkg)
        val size = 96
        val bitmap = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(bitmap)
        drawable.setBounds(0, 0, size, size)
        drawable.draw(canvas)
        val bytes = java.io.ByteArrayOutputStream()
        bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, bytes)
        return bytes.toByteArray()
    }

    // Apps with a launcher icon, with the name a person sees under the icon.
    // Open an app the way its home screen icon does, on a fresh task so it starts on its default screen.
    // An accessibility service may start activities from the background, so no shell is needed.
    private fun launch(pkg: String): JSONObject {
        if (android.os.Build.VERSION.SDK_INT >= 31) performGlobalAction(GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE)
        val intent = packageManager.getLaunchIntentForPackage(pkg) ?: error("$pkg has no launcher entry")
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK)
        startActivity(intent)
        // Answer once its window is in front, so the caller reads the app and not the screen before it.
        val until = System.currentTimeMillis() + 5000
        while (System.currentTimeMillis() < until) {
            if (windows.any { it.root?.packageName?.toString() == pkg && it.isActive }) return JSONObject().put("ok", true)
            Thread.sleep(60)
        }
        return JSONObject().put("ok", true).put("waited", false)
    }

    // What the studio shows about the phone.
    private fun device(): JSONObject {
        val battery = registerReceiver(null, android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, 100) ?: 100
        val plugged = (battery?.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
        val size = android.graphics.Point()
        @Suppress("DEPRECATION")
        (getSystemService(WINDOW_SERVICE) as android.view.WindowManager).defaultDisplay.getRealSize(size)
        return JSONObject().put("ok", true)
            .put("model", android.os.Build.MODEL).put("android", android.os.Build.VERSION.RELEASE)
            .put("battery", if (level >= 0) level * 100 / scale else JSONObject.NULL).put("charging", plugged)
            .put("width", size.x).put("height", size.y)
    }

    private fun apps(): JSONObject {
        val intent = android.content.Intent(android.content.Intent.ACTION_MAIN).addCategory(android.content.Intent.CATEGORY_LAUNCHER)
        val seen = HashSet<String>()
        val arr = JSONArray()
        for (ri in packageManager.queryIntentActivities(intent, 0)) {
            val pkg = ri.activityInfo.packageName
            if (!seen.add(pkg)) continue
            val flags = ri.activityInfo.applicationInfo.flags
            // Preinstalled, even if updated since: the person did not choose to install it.
            val system = flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM != 0
            arr.put(JSONObject().put("package", pkg).put("label", ri.loadLabel(packageManager).toString()).put("system", system))
        }
        return JSONObject().put("ok", true).put("apps", arr)
    }

    private fun global(name: String): JSONObject {
        val action = when (name) {
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
            "quick_settings" -> GLOBAL_ACTION_QUICK_SETTINGS
            "power_dialog" -> GLOBAL_ACTION_POWER_DIALOG
            "lock_screen" -> GLOBAL_ACTION_LOCK_SCREEN
            "screenshot" -> GLOBAL_ACTION_TAKE_SCREENSHOT
            "split_screen" -> GLOBAL_ACTION_TOGGLE_SPLIT_SCREEN
            else -> return JSONObject().put("ok", false).put("error", "unknown global action $name")
        }
        return JSONObject().put("ok", performGlobalAction(action))
    }

    // Accessibility actions on a node, walking up to the nearest parent that supports the action.
    private fun nodeAction(body: JSONObject): JSONObject {
        val node = nodeFor(body)
        val name = body.optString("action")
        val action: Int = when (name) {
            "click" -> AccessibilityNodeInfo.ACTION_CLICK
            "long_click" -> AccessibilityNodeInfo.ACTION_LONG_CLICK
            "scroll_forward" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            "scroll_backward" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            "focus" -> AccessibilityNodeInfo.ACTION_FOCUS
            "expand" -> AccessibilityNodeInfo.ACTION_EXPAND
            "collapse" -> AccessibilityNodeInfo.ACTION_COLLAPSE
            "dismiss" -> AccessibilityNodeInfo.ACTION_DISMISS
            "ime_enter" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id
            else -> return JSONObject().put("ok", false).put("error", "unknown node action $name")
        }
        var target: AccessibilityNodeInfo? = node
        while (target != null) {
            if (target.actionList.any { it.id == action } && target.performAction(action)) return JSONObject().put("ok", true)
            target = target.parent
        }
        return JSONObject().put("ok", false).put("error", "no node in the chain supports $name")
    }

    private fun setText(body: JSONObject): JSONObject {
        val node = nodeFor(body)
        node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, body.optString("text")) }
        return JSONObject().put("ok", node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args))
    }

    private fun tapAt(x: Float, y: Float): Boolean = gesture(Path().apply { moveTo(x, y) }, 60)

    private fun swipe(b: JSONObject): Boolean = gesture(Path().apply {
        moveTo(b.getDouble("x1").toFloat(), b.getDouble("y1").toFloat())
        lineTo(b.getDouble("x2").toFloat(), b.getDouble("y2").toFloat())
    }, b.optLong("ms", 300))

    private fun gesture(path: Path, ms: Long): Boolean {
        val done = CountDownLatch(1)
        var ok = false
        val g = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, ms)).build()
        dispatchGesture(g, object : GestureResultCallback() {
            override fun onCompleted(d: GestureDescription?) { ok = true; done.countDown() }
            override fun onCancelled(d: GestureDescription?) { done.countDown() }
        }, null)
        done.await(ms + 2000, TimeUnit.MILLISECONDS)
        return ok
    }

    companion object { const val PORT = 7912 }
}
