package dev.stitch.hands

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo

/**
 * Shows what the agent sees, like the developer option that draws layout bounds, but only for the app in front.
 * Live boxes follow the screen as it changes (redrawn on accessibility events, at most ten times a second); a bold
 * box marks the element the agent is about to use and disappears as soon as the screen moves. Drawn in an
 * accessibility overlay that takes no touches and no focus, so apps and the agent's own screen reading are untouched.
 */
class Overlay(private val service: AccessibilityService) {

    private val main = Handler(Looper.getMainLooper())
    private var view: BoxView? = null

    @Volatile var live = false
        private set

    private var pending = false
    private val refresh = Runnable { pending = false; redraw() }
    // Safety net for screens that change without telling anyone.
    private val tick = object : Runnable {
        override fun run() { if (live) { redraw(); main.postDelayed(this, 400) } }
    }
    private val clearTarget = Runnable { view?.target = null; view?.invalidate() }

    fun setLive(on: Boolean) = main.post {
        live = on
        main.removeCallbacks(tick)
        if (on) { (view ?: attach())?.let { redraw(); main.postDelayed(tick, 400) } }
        else view?.let { it.boxes = emptyList(); it.invalidate() }
    }

    // Called for every accessibility event; coalesced into one redraw per 100 ms.
    fun changed(moved: Boolean) {
        if (moved) main.post { main.removeCallbacks(clearTarget); clearTarget.run() }
        if (!live || pending) return
        pending = true
        main.postDelayed(refresh, 100)
    }

    fun target(rect: RectF?, ms: Long) = main.post {
        val v = view ?: attach() ?: return@post
        v.target = rect
        v.keyboard = keyboardRect()
        v.invalidate()
        main.removeCallbacks(clearTarget)
        if (rect != null) main.postDelayed(clearTarget, ms)
    }

    fun detach() = main.post {
        main.removeCallbacks(tick)
        view?.let { runCatching { (service.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(it) } }
        view = null
    }

    private fun redraw() {
        val v = view ?: return
        if (!live) return
        v.boxes = runCatching { boxesOfFrontApp() }.getOrDefault(emptyList())
        v.keyboard = keyboardRect()
        v.invalidate()
    }

    private fun keyboardRect(): RectF? = service.windows
        .firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }
        ?.let { w -> Rect().also { w.getBoundsInScreen(it) } }?.let { RectF(it) }

    // Elements of the app in front: anything you can tap or type into, and anything that shows text.
    private fun boxesOfFrontApp(): List<RectF> {
        val app = service.windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_APPLICATION && it.isActive }
            ?: service.windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
        val root = app?.root ?: return emptyList()
        if (root.packageName?.toString() == service.packageName) return emptyList()
        val screen = Rect().also { root.getBoundsInScreen(it) }
        val screenArea = screen.width().toLong() * screen.height()
        val out = ArrayList<RectF>(128)
        val r = Rect()
        fun walk(n: AccessibilityNodeInfo?, depth: Int) {
            if (n == null || depth > 60 || out.size >= 220) return
            if (n.isVisibleToUser) {
                n.getBoundsInScreen(r)
                val area = r.width().toLong() * r.height()
                val meaningful = n.isClickable || n.isEditable || !n.text.isNullOrBlank() || !n.contentDescription.isNullOrBlank()
                if (meaningful && area > 0 && area < screenArea / 2) out.add(RectF(r))
            }
            for (i in 0 until n.childCount) walk(n.getChild(i), depth + 1)
        }
        walk(root, 0)
        return out
    }

    private fun attach(): BoxView? {
        val wm = service.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        )
        // Cover the whole screen, status bar and cutout included, so element bounds map one to one.
        if (Build.VERSION.SDK_INT >= 30) params.fitInsetsTypes = 0
        if (Build.VERSION.SDK_INT >= 28) params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
        val v = BoxView(service)
        return runCatching { wm.addView(v, params); v }.getOrNull()?.also { view = it }
    }

    private class BoxView(context: Context) : View(context) {
        var boxes: List<RectF> = emptyList()
        var target: RectF? = null
        var keyboard: RectF? = null
        private val origin = IntArray(2)
        private val density = context.resources.displayMetrics.density

        private val thin = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE; strokeWidth = 1.2f * density; color = Color.argb(140, 232, 168, 76)
        }
        private val bold = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE; strokeWidth = 3.5f * density; color = Color.rgb(255, 196, 64)
        }
        private val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.FILL; color = Color.argb(46, 255, 196, 64)
        }

        override fun onDraw(canvas: Canvas) {
            // Bounds come in screen coordinates; shift by where this window actually starts.
            getLocationOnScreen(origin)
            canvas.translate(-origin[0].toFloat(), -origin[1].toFloat())
            // Elements the app still reports under an open keyboard are hidden; do not draw over the keyboard.
            keyboard?.let { canvas.clipOutRect(it) }
            val r = 4f * density
            for (b in boxes) canvas.drawRoundRect(b, r, r, thin)
            target?.let {
                val t = RectF(it).apply { inset(-3f * density, -3f * density) }
                canvas.drawRoundRect(t, r * 2, r * 2, glow)
                canvas.drawRoundRect(t, r * 2, r * 2, bold)
            }
        }
    }
}
