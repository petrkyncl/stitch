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

    // A thin bar instead of a full keyboard, so the app stays visible.
    override fun onCreateInputView(): View = TextView(this).apply {
        text = "Stitch keyboard"
        gravity = Gravity.CENTER
        setTextColor(Color.parseColor("#A8969F"))
        setBackgroundColor(Color.parseColor("#130E12"))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        val pad = (8 * resources.displayMetrics.density).toInt()
        setPadding(pad, pad, pad, pad)
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
