#pragma once
#include "scene/node.h"

namespace scene {

struct Transform {
    float position[3] = {0, 0, 0};
    float rotation[4] = {0, 0, 0, 1};
    float scale[3] = {1, 1, 1};
};

class Spatial : public Node {
public:
    const Transform& transform() const { return m_transform; }
    void setTransform(const Transform& t) { m_transform = t; }
    Transform globalTransform() const;

    bool visible = true;

protected:
    Transform m_transform;
};

} // namespace scene
