#pragma once
#include "render/renderer.h"

namespace render {

class GLRenderer : public Renderer {
public:
    bool initialize(int width, int height) override;
    void beginFrame() override;
    void endFrame() override;
    const char* backendName() const override { return "OpenGL"; }

private:
    unsigned m_vao = 0;
    unsigned m_defaultFbo = 0;
};

class GLES3Renderer : public GLRenderer {
};

} // namespace render
