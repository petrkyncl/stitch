package dev.stitch.hands

import android.graphics.Color
import android.inputmethodservice.InputMethodService
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.TextView
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

    // A real keyboard a person can use too: letters, numbers and symbols, shift, delete, space and the field's
    // own Enter action. The globe key switches back to the person's usual keyboard.
    private var symbols = false
    private var shift = false
    private var root: android.widget.LinearLayout? = null

    private val letters = listOf("1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm")
    private val signs = listOf("1234567890", "@#$%&-+()/", "*\"':;!?_=", ",.<>[]{}")

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    override fun onCreateInputView(): View {
        val box = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#130E12"))
            setPadding(dp(4), dp(4), dp(4), dp(22)) // room for the gesture bar
        }
        root = box
        render()
        return box
    }

    override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        shift = false
        render()
    }

    private fun render() {
        val box = root ?: return
        box.removeAllViews()
        box.addView(TextView(this).apply {
            text = "Stitch keyboard"
            gravity = Gravity.CENTER
            setTextColor(Color.parseColor("#A8969F"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            setPadding(0, dp(2), 0, dp(4))
        })
        val rows = if (symbols) signs else letters
        rows.forEachIndexed { i, chars ->
            val row = newRow()
            if (i == 3 && !symbols) row.addView(key(if (shift) "⇧ on" else "⇧", 1.5f) { shift = !shift; render() })
            for (c in chars) {
                val label = if (shift && !symbols) c.uppercase() else c.toString()
                row.addView(key(label, 1f) { commit(label); if (shift) { shift = false; render() } })
            }
            if (i == 3) row.addView(key("⌫", 1.5f) { backspace() })
            box.addView(row)
        }
        val bottom = newRow()
        bottom.addView(key("🌐", 1.2f, onLong = {
            (getSystemService(INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager).showInputMethodPicker()
        }) { if (!switchToPreviousInputMethod()) (getSystemService(INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager).showInputMethodPicker() })
        bottom.addView(key(if (symbols) "abc" else "?123", 1.4f) { symbols = !symbols; render() })
        bottom.addView(key(",", 1f) { commit(",") })
        bottom.addView(key("space", 4f) { commit(" ") })
        bottom.addView(key(".", 1f) { commit(".") })
        bottom.addView(key("⏎", 1.6f, accent = true) { enter() })
        box.addView(bottom)
    }

    private fun newRow() = android.widget.LinearLayout(this).apply {
        orientation = android.widget.LinearLayout.HORIZONTAL
        layoutParams = android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, dp(46))
    }

    private fun key(label: String, weight: Float, accent: Boolean = false, onLong: (() -> Unit)? = null, onTap: () -> Unit): View =
        TextView(this).apply {
            text = label
            gravity = Gravity.CENTER
            setTextColor(Color.parseColor(if (accent) "#130E12" else "#EFE4DD"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, if (label.length > 2) 13f else 19f)
            background = android.graphics.drawable.GradientDrawable().apply {
                cornerRadius = dp(7).toFloat()
                setColor(Color.parseColor(if (accent) "#F3A64A" else "#251C24"))
            }
            layoutParams = android.widget.LinearLayout.LayoutParams(0, android.widget.LinearLayout.LayoutParams.MATCH_PARENT, weight).apply {
                setMargins(dp(2), dp(3), dp(2), dp(3))
            }
            isClickable = true
            setOnClickListener { performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP); onTap() }
            if (onLong != null) setOnLongClickListener { onLong(); true }
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
            val ic = currentInputConnection ?: return@onMain
            ic.performContextMenuAction(android.R.id.selectAll)
            ic.commitText("", 1)
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
    }
}
