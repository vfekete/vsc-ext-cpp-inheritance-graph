#pragma once
#include <cstddef>

namespace acme {

class Allocator {
public:
    virtual ~Allocator() = default;
    virtual void* allocate(std::size_t size, std::size_t align) = 0;
    virtual void deallocate(void* ptr) = 0;
};

class LinearAllocator : public Allocator {
public:
    void* allocate(std::size_t size, std::size_t align) override;
    void deallocate(void*) override {}
    void reset() { m_offset = 0; }
private:
    std::size_t m_offset = 0;
};

} // namespace acme
