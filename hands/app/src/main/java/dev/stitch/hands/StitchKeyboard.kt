package dev.stitch.hands

import android.graphics.Color
import android.inputmethodservice.InputMethodService
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.random.Random

/**
 * A keyboard the agent types with. Text is committed through the input connection like a real keyboard,
 * either at once or character by character with human pauses, and Enter fires the field's own action.
 */
class StitchKeyboard : InputMethodService() {

    private val main = Handler(Looper.getMainLooper())

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    // A real keyboard a person can use too, laid out like the iPhone's: letters only, numbers and symbols one tap
    // away, drawn icons for shift, delete and the globe, and a return key named after the field's own action.
    private enum class Page { LETTERS, NUMBERS, SYMBOLS }
    private var page = Page.LETTERS
    private var shift = 0 // 0 off, 1 next letter, 2 caps lock
    private var shiftTappedAt = 0L
    private var spaceTappedAt = 0L
    private var root: android.widget.LinearLayout? = null

    private val letterRows = listOf("qwertyuiop", "asdfghjkl", "zxcvbnm")
    private val numberRows = listOf("1234567890", "-/:;()$&@\"", ".,?!'")
    private val symbolRows = listOf("[]{}#%^*+=", "_\\|~<>€£¥•", ".,?!'")

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun dpf(v: Float) = v * resources.displayMetrics.density

    override fun onCreateInputView(): View {
        val box = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setBackgroundColor(BG)
            setPadding(dp(3), dp(6), dp(3), dp(22))
        }
        // The keyboard is drawn edge to edge, and the system puts its own buttons (switch keyboard, hide) in the
        // navigation bar below it. Keep the keys above that bar, whatever its height on this phone.
        box.setOnApplyWindowInsetsListener { v, insets ->
            val bottom = if (android.os.Build.VERSION.SDK_INT >= 30) {
                insets.getInsets(android.view.WindowInsets.Type.navigationBars() or android.view.WindowInsets.Type.tappableElement()).bottom
            } else @Suppress("DEPRECATION") insets.systemWindowInsetBottom
            v.setPadding(dp(3), dp(6), dp(3), maxOf(bottom, dp(22)) + dp(2))
            insets
        }
        root = box
        render()
        return box
    }

    override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        page = Page.LETTERS
        shift = 0
        autoCaps()
        render()
    }

    // Capital letter at the start of a sentence, when the field asks for it.
    private fun autoCaps() {
        if (shift == 2) return
        val caps = runCatching { currentInputConnection?.getCursorCapsMode(currentInputEditorInfo?.inputType ?: 0) ?: 0 }.getOrDefault(0)
        val want = if (caps != 0) 1 else 0
        if (want != shift) { shift = want; render() }
    }

    private fun render() {
        val box = root ?: return
        box.removeAllViews()
        val rows = when (page) { Page.LETTERS -> letterRows; Page.NUMBERS -> numberRows; Page.SYMBOLS -> symbolRows }

        box.addView(row(rows[0].map { charKey(it, 1f) }))
        // The middle row of letters is one key shorter and sits centered, as on the iPhone.
        val second = rows[1].map { charKey(it, 1f) }
        box.addView(row(if (page == Page.LETTERS) listOf(spacer(0.5f)) + second + spacer(0.5f) else second))

        val third = mutableListOf<View>()
        third += when (page) {
            Page.LETTERS -> KeyView(this, Kind.ICON, icon = if (shift == 2) Icon.CAPS else if (shift == 1) Icon.SHIFT_ON else Icon.SHIFT, fn = true, weight = 1.35f, active = shift > 0) { tapShift() }
            Page.NUMBERS -> KeyView(this, Kind.SMALL, "#+=", fn = true, weight = 1.35f) { page = Page.SYMBOLS; render() }
            Page.SYMBOLS -> KeyView(this, Kind.SMALL, "123", fn = true, weight = 1.35f) { page = Page.NUMBERS; render() }
        }
        third += spacer(0.15f)
        val middle = rows[2]
        val w = if (page == Page.LETTERS) 1f else 7f / middle.length
        third += middle.map { charKey(it, w) }
        third += spacer(0.15f)
        third += KeyView(this, Kind.ICON, icon = Icon.DELETE, fn = true, weight = 1.35f, repeat = true) { backspace(); autoCaps() }
        box.addView(row(third))

        val imm = getSystemService(INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager
        val action = returnAction()
        box.addView(row(listOf(
            KeyView(this, Kind.SMALL, if (page == Page.LETTERS) "123" else "ABC", fn = true, weight = 1.25f) {
                page = if (page == Page.LETTERS) Page.NUMBERS else Page.LETTERS; render()
            },
            KeyView(this, Kind.ICON, icon = Icon.GLOBE, fn = true, weight = 1.25f, onLong = { imm.showInputMethodPicker() }) {
                if (!switchToPreviousInputMethod()) imm.showInputMethodPicker()
            },
            KeyView(this, Kind.SMALL, "Stitch", muted = true, weight = 5f) { space() },
            KeyView(this, Kind.SMALL, action.first, fn = !action.second, accent = action.second, weight = 2.5f) { enter() },
        )))
    }

    private fun charKey(c: Char, weight: Float): View {
        val label = if (page == Page.LETTERS && shift > 0) c.uppercaseChar().toString() else c.toString()
        return KeyView(this, Kind.CHAR, label, weight = weight) {
            commit(label)
            if (shift == 1) shift = 0
            if (page != Page.LETTERS && label == "'") page = Page.LETTERS
            render()
            autoCaps()
        }
    }

    private fun tapShift() {
        val now = SystemClock.uptimeMillis()
        shift = when {
            shift == 2 -> 0
            shift == 1 && now - shiftTappedAt < 320 -> 2 // double tap: caps lock
            shift == 1 -> 0
            else -> 1
        }
        shiftTappedAt = now
        render()
    }

    // Double space ends the sentence, as on the iPhone.
    private fun space() {
        val ic = currentInputConnection ?: return
        val now = SystemClock.uptimeMillis()
        val before = ic.getTextBeforeCursor(2, 0)?.toString() ?: ""
        if (now - spaceTappedAt < 450 && before.length == 2 && before[1] == ' ' && before[0].isLetterOrDigit()) {
            ic.deleteSurroundingText(1, 0)
            ic.commitText(". ", 1)
            spaceTappedAt = 0
        } else {
            ic.commitText(" ", 1)
            spaceTappedAt = now
        }
        if (page != Page.LETTERS) { page = Page.LETTERS; render() }
        autoCaps()
    }

    // The return key says what the field will do, and is highlighted when that is an action (go, search, send).
    private fun returnAction(): Pair<String, Boolean> {
        val opts = currentInputEditorInfo?.imeOptions ?: 0
        if (opts and EditorInfo.IME_FLAG_NO_ENTER_ACTION != 0) return "return" to false
        return when (opts and EditorInfo.IME_MASK_ACTION) {
            EditorInfo.IME_ACTION_GO -> "go" to true
            EditorInfo.IME_ACTION_SEARCH -> "search" to true
            EditorInfo.IME_ACTION_SEND -> "send" to true
            EditorInfo.IME_ACTION_DONE -> "done" to true
            EditorInfo.IME_ACTION_NEXT -> "next" to false
            else -> "return" to false
        }
    }

    private fun row(keys: List<View>) = android.widget.LinearLayout(this).apply {
        orientation = android.widget.LinearLayout.HORIZONTAL
        layoutParams = android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, dp(46))
        keys.forEach { addView(it) }
    }

    private fun spacer(weight: Float) = View(this).apply {
        layoutParams = android.widget.LinearLayout.LayoutParams(0, 1, weight)
    }

    private enum class Kind { CHAR, SMALL, ICON }
    private enum class Icon { SHIFT, SHIFT_ON, CAPS, DELETE, GLOBE }

    // One key, drawn by hand: a rounded face with a soft bottom edge, a letter, a word or a vector icon.
    private inner class KeyView(
        context: android.content.Context,
        private val kind: Kind,
        private val label: String = "",
        private val icon: Icon? = null,
        private val fn: Boolean = false,
        private val accent: Boolean = false,
        private val active: Boolean = false,
        private val muted: Boolean = false,
        private val repeat: Boolean = false,
        weight: Float,
        private val onLong: (() -> Unit)? = null,
        private val onTap: () -> Unit,
    ) : View(context) {
        private var down = false
        private val face = android.graphics.RectF()
        private val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
        private val text = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            textAlign = android.graphics.Paint.Align.CENTER
            typeface = android.graphics.Typeface.create("sans-serif", android.graphics.Typeface.NORMAL)
        }
        private val stroke = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            style = android.graphics.Paint.Style.STROKE; strokeWidth = dpf(1.5f)
            strokeJoin = android.graphics.Paint.Join.ROUND; strokeCap = android.graphics.Paint.Cap.ROUND
        }
        private val repeater = object : Runnable {
            override fun run() { onTap(); postDelayed(this, 55) }
        }
        private val longPress = Runnable { onLong?.invoke(); fired = true; down = false; invalidate() }
        private var fired = false

        init {
            layoutParams = android.widget.LinearLayout.LayoutParams(0, android.widget.LinearLayout.LayoutParams.MATCH_PARENT, weight)
            contentDescription = label.ifEmpty { icon?.name?.lowercase() }
        }

        override fun onDraw(canvas: android.graphics.Canvas) {
            val gapX = dpf(2.5f); val gapY = dpf(4f); val r = dpf(5f)
            face.set(gapX, gapY, width - gapX, height - gapY)
            // the key's lower edge, like a physical key catching light from above
            paint.color = SHADOW
            canvas.drawRoundRect(face.left, face.top + dpf(1.2f), face.right, face.bottom + dpf(1.2f), r, r, paint)
            paint.color = when {
                accent -> if (down) ACCENT_DOWN else ACCENT
                active && kind == Kind.ICON -> if (down) KEY_DOWN else KEY
                fn -> if (down) KEY else FN
                else -> if (down) KEY_DOWN else KEY
            }
            canvas.drawRoundRect(face, r, r, paint)

            val ink = if (accent) BG else INK
            val cx = face.centerX(); val cy = face.centerY()
            when (kind) {
                Kind.CHAR -> {
                    text.color = ink; text.textSize = dpf(if (label[0].isLowerCase()) 20f else 18.5f)
                    // lowercase letters sit a touch lower, so their visual center matches the capitals
                    val lift = if (label[0].isLowerCase()) dpf(1.2f) else 0f
                    canvas.drawText(label, cx, cy - (text.descent() + text.ascent()) / 2 - lift, text)
                }
                Kind.SMALL -> {
                    text.color = if (muted) MUTED else ink; text.textSize = dpf(if (muted) 13f else 14f)
                    canvas.drawText(label, cx, cy - (text.descent() + text.ascent()) / 2, text)
                }
                Kind.ICON -> drawIcon(canvas, cx, cy, ink)
            }
        }

        private fun drawIcon(canvas: android.graphics.Canvas, cx: Float, cy: Float, ink: Int) {
            val u = dpf(0.82f)
            stroke.color = ink
            val path = android.graphics.Path()
            fun p(x: Float, y: Float, first: Boolean = false) = if (first) path.moveTo(cx + x * u, cy + y * u) else path.lineTo(cx + x * u, cy + y * u)
            when (icon) {
                Icon.SHIFT, Icon.SHIFT_ON, Icon.CAPS -> {
                    p(0f, -10f, true); p(10f, 0f); p(4.5f, 0f); p(4.5f, 8f); p(-4.5f, 8f); p(-4.5f, 0f); p(-10f, 0f); path.close()
                    if (icon == Icon.SHIFT) canvas.drawPath(path, stroke)
                    else { paint.color = ink; canvas.drawPath(path, paint) }
                    if (icon == Icon.CAPS) canvas.drawLine(cx - 4.5f * u, cy + 11.5f * u, cx + 4.5f * u, cy + 11.5f * u, stroke)
                }
                Icon.DELETE -> {
                    p(-12f, 0f, true); p(-5.5f, -8.5f); p(11f, -8.5f); p(11f, 8.5f); p(-5.5f, 8.5f); path.close()
                    canvas.drawPath(path, stroke)
                    canvas.drawLine(cx - 1f * u, cy - 3.5f * u, cx + 6f * u, cy + 3.5f * u, stroke)
                    canvas.drawLine(cx - 1f * u, cy + 3.5f * u, cx + 6f * u, cy - 3.5f * u, stroke)
                }
                Icon.GLOBE -> {
                    val r = 9.5f * u
                    canvas.drawCircle(cx, cy, r, stroke)
                    canvas.drawOval(cx - 4.2f * u, cy - r, cx + 4.2f * u, cy + r, stroke)
                    canvas.drawLine(cx - r, cy, cx + r, cy, stroke)
                    val chord = Math.sqrt((r * r - (4.8f * u) * (4.8f * u)).toDouble()).toFloat()
                    canvas.drawLine(cx - chord, cy - 4.8f * u, cx + chord, cy - 4.8f * u, stroke)
                    canvas.drawLine(cx - chord, cy + 4.8f * u, cx + chord, cy + 4.8f * u, stroke)
                }
                null -> {}
            }
        }

        @android.annotation.SuppressLint("ClickableViewAccessibility")
        override fun onTouchEvent(e: android.view.MotionEvent): Boolean {
            when (e.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> {
                    down = true; fired = false; invalidate()
                    performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP)
                    if (repeat) { onTap(); fired = true; postDelayed(repeater, 420) }
                    if (onLong != null) postDelayed(longPress, 450)
                }
                android.view.MotionEvent.ACTION_UP -> {
                    removeCallbacks(repeater); removeCallbacks(longPress)
                    val wasDown = down
                    down = false; invalidate()
                    if (wasDown && !fired) onTap()
                }
                android.view.MotionEvent.ACTION_CANCEL -> {
                    removeCallbacks(repeater); removeCallbacks(longPress); down = false; invalidate()
                }
            }
            return true
        }
    }

    private fun commit(text: String) { currentInputConnection?.commitText(text, 1) }

    private fun backspace() {
        val ic = currentInputConnection ?: return
        val selected = ic.getSelectedText(0)
        if (!selected.isNullOrEmpty()) ic.commitText("", 1) else ic.deleteSurroundingText(1, 0)
    }

    val ready: Boolean get() = currentInputConnection != null && currentInputStarted

    private var currentInputStarted = false
    override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
        currentInputStarted = true
    }
    override fun onFinishInput() {
        currentInputStarted = false
        super.onFinishInput()
    }

    private fun <T> onMain(block: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        var result: Result<T>? = null
        val done = CountDownLatch(1)
        main.post { result = runCatching(block); done.countDown() }
        done.await(5, TimeUnit.SECONDS)
        return (result ?: error("keyboard did not answer")).getOrThrow()
    }

    fun type(text: String, replace: Boolean, human: Boolean): Boolean {
        if (replace) onMain {
            // Clear what is there by deleting around the cursor. "Select all" from the context menu is ignored by
            // some fields (Jetpack Compose, e.g. the Claude app), which left an old draft and doubled the text.
            val ic = currentInputConnection ?: return@onMain
            ic.beginBatchEdit()
            ic.finishComposingText()
            if (!ic.getSelectedText(0).isNullOrEmpty()) ic.commitText("", 1)
            val before = ic.getTextBeforeCursor(100_000, 0)?.length ?: 0
            val after = ic.getTextAfterCursor(100_000, 0)?.length ?: 0
            if (before + after > 0) ic.deleteSurroundingText(before, after)
            ic.endBatchEdit()
        }
        if (!human) return onMain { currentInputConnection?.commitText(text, 1) ?: false }
        for (ch in text) {
            val ok = onMain { currentInputConnection?.commitText(ch.toString(), 1) ?: false }
            if (!ok) return false
            SystemClock.sleep(Random.nextLong(35, 110))
        }
        return true
    }

    // The field's own action (Send, Search, Done, Next) when it has one, otherwise a plain Enter key.
    fun enter(): Boolean = onMain {
        val ic = currentInputConnection ?: return@onMain false
        val action = (currentInputEditorInfo?.imeOptions ?: 0) and EditorInfo.IME_MASK_ACTION
        if (action != EditorInfo.IME_ACTION_NONE && action != EditorInfo.IME_ACTION_UNSPECIFIED) {
            ic.performEditorAction(action)
        } else {
            ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
            ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER))
        }
    }

    companion object {
        @Volatile var instance: StitchKeyboard? = null

        // Stitch's night palette in the shape of the iPhone's dark keyboard.
        private val BG = Color.parseColor("#130E12")
        private val KEY = Color.parseColor("#3A3036")
        private val KEY_DOWN = Color.parseColor("#56474F")
        private val FN = Color.parseColor("#251D22")
        private val SHADOW = Color.parseColor("#070406")
        private val INK = Color.parseColor("#F4ECE6")
        private val MUTED = Color.parseColor("#9C8C95")
        private val ACCENT = Color.parseColor("#F3A64A")
        private val ACCENT_DOWN = Color.parseColor("#C98634")
    }
}
