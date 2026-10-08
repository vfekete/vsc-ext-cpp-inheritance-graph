#pragma once
#include "core/config.h"
// Hidden include through a macro: expands to <core/refcounted.h>
#include CORE_HEADER(refcounted)
#include <acme/allocator.h>

namespace render {

class ENGINE_API Renderer : public core::RefCounted {
public:
    virtual ~Renderer() = default;
    virtual bool initialize(int width, int height) = 0;
    virtual void beginFrame() = 0;
    virtual void endFrame() = 0;
    virtual const char* backendName() const = 0;

protected:
    acme::Allocator* m_allocator = nullptr;
    int m_width = 0;
    int m_height = 0;
};

class FrameAllocator : public acme::LinearAllocator {
public:
    void resetFrame();
};

} // namespace render
