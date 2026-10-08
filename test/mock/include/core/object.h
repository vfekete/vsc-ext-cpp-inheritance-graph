#ifndef CORE_OBJECT_H
#define CORE_OBJECT_H

#include <string>
#include <cstdint>

namespace core {


class Object {
public:
    Object() = default;
    virtual ~Object() = default;

    virtual std::string typeName() const { return "Object"; }
    std::uint64_t id() const { return m_id; }

protected:
    void setId(std::uint64_t id) { m_id = id; }

private:
    std::uint64_t m_id = 0;
    static std::uint64_t s_nextId;
};

} // namespace core

#endif // CORE_OBJECT_H
