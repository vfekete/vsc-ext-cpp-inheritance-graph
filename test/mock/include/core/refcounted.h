#pragma once
#include "core/object.h"
#include <atomic>

namespace core {

class RefCounted : public Object {
public:
    void ref() { ++m_refs; }
    bool unref() { return --m_refs == 0; }
    int refCount() const { return m_refs.load(); }

private:
    std::atomic<int> m_refs{0};
};

template <typename T>
class Ref {
public:
    T* get() const { return m_ptr; }
private:
    T* m_ptr = nullptr;
};

} // namespace core
