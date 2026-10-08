#pragma once
#include "core/config.h"
#include RENDER_BACKEND_HEADER

#if ENGINE_USE_VULKAN
namespace render::vk {

class VulkanRenderer : public render::Renderer {
public:
    bool initialize(int width, int height) override;
    void beginFrame() override;
    void endFrame() override;
    const char* backendName() const override { return "Vulkan"; }

    unsigned queueFamily = 0;

private:
    void* m_instance = nullptr;
    void* m_device = nullptr;
};

class MoltenVkRenderer final : public VulkanRenderer {
public:
    const char* backendName() const override { return "MoltenVK"; }
};

} // namespace render::vk
#else
namespace render::vk {
class VulkanRenderer;  // disabled build
}
#endif
