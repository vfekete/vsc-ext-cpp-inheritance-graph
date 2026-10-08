#pragma once
#include "core/config.h"
#include SCENE_HEADER(visual)
#include "scene/mixins/serializable.h"

namespace scene {

class MeshInstance : public GeometryInstance {
public:
    int mesh() const { return m_mesh; }
    void setMesh(int meshId) { m_mesh = meshId; }
    float boundingRadius() const override { return m_radius; }

private:
    int m_mesh = -1;
    float m_radius = 0.0f;
};

class SkinnedMeshInstance : public MeshInstance, public mixins::Skinnable {
public:
    void updatePose(float dt);
    int boneCount = 0;
};

// Inheritance hidden behind a macro: only a preprocessor-aware tool sees it.
DECLARE_COMPONENT(AnimatedCharacterMesh, SkinnedMeshInstance) {
public:
    void playAnimation(const char* name, bool loop = true);
    void stopAnimation();
    float playbackSpeed = 1.0f;

private:
    int m_currentAnimation = -1;
};

} // namespace scene
