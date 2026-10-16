package global.cpay.app.common.ui

import android.graphics.Canvas
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView

/**
 * En-tetes collants pour une liste dont certains elements sont des en-tetes
 * (journal : regroupement par jour). L'adaptateur fournit la position de
 * l'en-tete courant et dessine son contenu dans une vue dediee.
 */
class StickyHeaderDecoration(
    private val isHeader: (position: Int) -> Boolean,
    private val createHeaderView: (parent: RecyclerView) -> View,
    private val bindHeaderView: (view: View, headerPosition: Int) -> Unit,
) : RecyclerView.ItemDecoration() {

    private var headerView: View? = null

    override fun onDrawOver(c: Canvas, parent: RecyclerView, state: RecyclerView.State) {
        val topChild = parent.getChildAt(0) ?: return
        val topPos = parent.getChildAdapterPosition(topChild)
        if (topPos == RecyclerView.NO_POSITION) return
        val headerPos = headerPositionFor(topPos) ?: return

        val header = headerView ?: createHeaderView(parent).also { headerView = it }
        bindHeaderView(header, headerPos)
        measure(parent, header)

        val contact = childInContact(parent, header.bottom)
        if (contact != null && isHeader(parent.getChildAdapterPosition(contact))) {
            c.save()
            c.translate(0f, (contact.top - header.height).toFloat())
            header.draw(c)
            c.restore()
        } else {
            c.save()
            c.translate(0f, 0f)
            header.draw(c)
            c.restore()
        }
    }

    private fun headerPositionFor(position: Int): Int? {
        var p = position
        while (p >= 0) { if (isHeader(p)) return p; p-- }
        return null
    }

    private fun childInContact(parent: RecyclerView, contactPoint: Int): View? {
        for (i in 0 until parent.childCount) {
            val child = parent.getChildAt(i)
            if (child.bottom > contactPoint && child.top <= contactPoint) return child
        }
        return null
    }

    private fun measure(parent: ViewGroup, view: View) {
        val widthSpec  = View.MeasureSpec.makeMeasureSpec(parent.width, View.MeasureSpec.EXACTLY)
        val heightSpec = View.MeasureSpec.makeMeasureSpec(parent.height, View.MeasureSpec.UNSPECIFIED)
        val lp = view.layoutParams
        val childWidth = ViewGroup.getChildMeasureSpec(widthSpec,
            parent.paddingLeft + parent.paddingRight, lp?.width ?: ViewGroup.LayoutParams.MATCH_PARENT)
        val childHeight = ViewGroup.getChildMeasureSpec(heightSpec,
            parent.paddingTop + parent.paddingBottom, lp?.height ?: ViewGroup.LayoutParams.WRAP_CONTENT)
        view.measure(childWidth, childHeight)
        view.layout(0, 0, view.measuredWidth, view.measuredHeight)
    }
}
