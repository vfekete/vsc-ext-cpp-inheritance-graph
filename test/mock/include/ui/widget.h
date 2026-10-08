#pragma once
#include "scene/node.h"

namespace ui {

// Diamond via virtual inheritance.
class Widget : public virtual scene::Node {
public:
    int width = 0, height = 0;
    virtual void paint() {}
    bool isHovered() const { return m_hovered; }
private:
    bool m_hovered = false;
};

class Focusable : public virtual scene::Node {
public:
    void focus();
    bool hasFocus() const { return m_focus; }
private:
    bool m_focus = false;
};

class Control : public Widget, public Focusable {
public:
    void paint() override;
    bool enabled = true;
};

} // namespace ui
