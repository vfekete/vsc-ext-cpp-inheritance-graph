#pragma once
#include "scene/spatial.h"

namespace scene {

class VisualInstance : public Spatial {
public:
    unsigned layerMask() const { return m_layers; }
    void setLayerMask(unsigned mask) { m_layers = mask; }
    virtual float boundingRadius() const = 0;

private:
    unsigned m_layers = 1;
};

class GeometryInstance : public VisualInstance {
public:
    enum class ShadowMode { Off, On, DoubleSided, ShadowsOnly };

    ShadowMode castShadows = ShadowMode::On;
    float lodBias = 1.0f;

    void setMaterialOverride(int materialId);

protected:
    int m_materialOverride = -1;
};

} // namespace scene
