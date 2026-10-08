package dev.stitch.hands

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager

/**
 * Shows what the agent sees: a thin box around every element it read, and a bold one around the element it is
 * about to use. Drawn in an accessibility overlay that takes no touches and no focus, so the apps and the agent's
 * own screen reading are untouched. Clears itself after a moment.
 */
class Overlay(private val service: AccessibilityService) {

    private val main = Handler(Looper.getMainLooper())
    private var view: BoxView? = null
    private val clear = Runnable { view?.set(emptyList(), null, null) }

    fun show(boxes: List<RectF>, target: RectF?, ms: Long) = main.post {
        val v = view ?: attach() ?: return@post
        // Elements the app still reports under an open keyboard are hidden; do not draw over the keyboard.
        val keyboard = service.windows.firstOrNull { it.type == android.view.accessibility.AccessibilityWindowInfo.TYPE_INPUT_METHOD }
            ?.let { w -> android.graphics.Rect().also { w.getBoundsInScreen(it) } }
        v.set(boxes, target, keyboard?.let { RectF(it) })
        main.removeCallbacks(clear)
        main.postDelayed(clear, ms)
    }

    fun hide() = main.post { view?.set(emptyList(), null, null) }

    fun detach() = main.post {
        view?.let { runCatching { (service.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(it) } }
        view = null
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
        private var boxes: List<RectF> = emptyList()
        private var target: RectF? = null
        private var keyboard: RectF? = null
        private val origin = IntArray(2)
        private val density = context.resources.displayMetrics.density

        private val thin = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE; strokeWidth = 1.5f * density; color = Color.argb(150, 232, 168, 76)
        }
        private val bold = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE; strokeWidth = 4f * density; color = Color.rgb(255, 196, 64)
        }
        private val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.FILL; color = Color.argb(46, 255, 196, 64)
        }

        fun set(boxes: List<RectF>, target: RectF?, keyboard: RectF?) {
            this.boxes = boxes
            this.target = target
            this.keyboard = keyboard
            invalidate()
        }

        override fun onDraw(canvas: Canvas) {
            // Bounds come in screen coordinates; shift by where this window actually starts.
            getLocationOnScreen(origin)
            canvas.translate(-origin[0].toFloat(), -origin[1].toFloat())
            keyboard?.let { canvas.clipOutRect(it) }
            val r = 6f * density
            for (b in boxes) canvas.drawRoundRect(b, r, r, thin)
            target?.let {
                val t = RectF(it).apply { inset(-3f * density, -3f * density) }
                canvas.drawRoundRect(t, r * 1.5f, r * 1.5f, glow)
                canvas.drawRoundRect(t, r * 1.5f, r * 1.5f, bold)
            }
        }
    }
}
