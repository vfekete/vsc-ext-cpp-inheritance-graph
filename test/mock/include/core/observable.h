#pragma once
#include <vector>
#include <functional>

namespace core {

template <typename Derived>
class Observable {
public:
    using Callback = std::function<void(Derived&)>;

    void subscribe(Callback cb) { m_callbacks.push_back(std::move(cb)); }
    void notify() {
        for (auto& cb : m_callbacks) cb(static_cast<Derived&>(*this));
    }

private:
    std::vector<Callback> m_callbacks;
};

} // namespace core
