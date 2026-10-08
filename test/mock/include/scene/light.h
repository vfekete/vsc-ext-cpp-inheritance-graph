#pragma once
#include "scene/visual.h"

namespace scene {

class Light : public VisualInstance {
public:
    float color[3] = {1, 1, 1};
    float energy = 1.0f;
    bool castsShadows = false;
    float boundingRadius() const override { return range(); }
    virtual float range() const = 0;
};

class DirectionalLight : public Light {
public:
    float range() const override { return 1e9f; }
    int shadowCascades = 4;
};

class OmniLight : public Light {
public:
    float range() const override { return m_range; }
    void setRange(float r) { m_range = r; }
protected:
    float m_range = 10.0f;
};

class SpotLight : public OmniLight {
public:
    float spotAngle = 45.0f;
    float spotAttenuation = 1.0f;
};

} // namespace scene
