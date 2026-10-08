#include "scene/mesh_instance.h"
#include "scene/light.h"
#include "scene/camera.h"
#include "render/vk_renderer.h"
#include "ui/button.h"
#include "core/exception.h"

int main() {
    scene::AnimatedCharacterMesh hero;
    hero.playAnimation("idle");
    render::vk::VulkanRenderer renderer;
    renderer.initialize(1280, 720);
    ui::RadioButton option;
    option.toggle();
    return 0;
}
