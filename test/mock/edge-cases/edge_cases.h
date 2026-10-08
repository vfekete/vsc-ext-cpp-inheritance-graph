#pragma once
// Parser torture test. Not part of the compiled mock project.
#include "scene/spatial.h"
#include "scene/mixins/serializable.h"

// Only reachable when the build defines PLUGIN_SDK_HEADER, e.g.
//   -DPLUGIN_SDK_HEADER='"sdk/plugin_base.h"'
// Without it the base below stays unresolved unless the language server knows better.
#ifdef PLUGIN_SDK_HEADER
#include PLUGIN_SDK_HEADER
#endif

#define EXPORT_API __attribute__((visibility("default")))
#define DECLSPEC(x)
#define Q_OBJECT_LIKE \
    public: static const char* staticMetaObject(); \
    private:

#if 0
class DeadCode : public scene::Spatial {};
#endif

#if defined(FEATURE_THAT_IS_OFF) && FEATURE_THAT_IS_OFF > 1
class WrongBranch : public scene::Node {};
#else
class RightBranch : public scene::Node {};
#endif

namespace edge {

namespace sm = ::scene::mixins;
using SpatialBase = scene::Spatial;
typedef scene::Node NodeBase;

// Base through a type alias and a namespace alias.
class EXPORT_API AliasUser : public SpatialBase, protected sm::ISerializable {
    Q_OBJECT_LIKE
public:
    std::string serialize() const override { return {}; }
    void deserialize(const std::string&) override {}
};

class DECLSPEC(dllexport) [[deprecated("old")]] alignas(16) TypedefUser final : private NodeBase {
public:
    explicit TypedefUser(int v) : m_value(v), m_other{v * 2} {}
    TypedefUser& operator=(const TypedefUser&) = default;
    bool operator==(const TypedefUser& o) const { return m_value == o.m_value; }
    int operator()(int x) const { return x + m_value; }
    void (*callback)(int, void*) = nullptr;
    unsigned flags : 3;
    static constexpr int kMax = 10;
    auto computed() const -> int { return m_value; }
private:
    int m_value;
    int m_other;
};

// Unresolved: nobody includes the header that defines it.
class PluginNode : public sdk::PluginBase, public scene::Node {
public:
    const char* pluginName() const override { return "edge"; }
};

// Primary template and explicit specialization.
template <typename T, int N = 4>
struct Buffer { T data[N]; };

template <>
struct Buffer<bool, 4> : public scene::mixins::Skinnable { unsigned bits = 0; };

class Outer {
public:
    class Inner : public scene::Spatial {
    public:
        int depth = 0;
    };
    Inner inner;
};

} // namespace edge

// C style
typedef struct {
    int x, y;
} CPoint;

extern "C++" {
struct Wrapped : edge::Outer {};
}
