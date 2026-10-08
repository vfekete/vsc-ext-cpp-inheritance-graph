#pragma once
#include "ui/widget.h"
#include <string>

namespace ui {

class Button : public Control {
public:
    std::string text;
    void click();
    void paint() override;
};

class CheckBox : public Button {
public:
    bool checked = false;
    void toggle() { checked = !checked; }
};

class RadioButton : public CheckBox {
public:
    int group = 0;
};

namespace widgets {

template <typename T>
class ValueControl : public Control {
public:
    T value{};
    void setValue(const T& v) { value = v; }
};

class Slider : public ValueControl<float> {
public:
    float minimum = 0.0f;
    float maximum = 1.0f;
    struct Style {
        int thickness = 4;
    } style;
};

class SpinBox : public ValueControl<int> {
public:
    int step = 1;
};

} // namespace widgets
} // namespace ui
