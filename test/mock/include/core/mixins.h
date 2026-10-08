#pragma once

namespace core {

// Mixin whose base class is a template parameter: traversal stops at `Base`.
template <typename Base>
class Named : public Base {
public:
    const char* displayName() const { return m_name; }
    void setDisplayName(const char* name) { m_name = name; }

private:
    const char* m_name = "";
};

} // namespace core
