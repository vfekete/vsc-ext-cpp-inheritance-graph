#pragma once
#include "scene/spatial.h"
#include "core/mixins.h"

namespace scene {

class Camera : public Spatial {
public:
    enum Projection { Perspective, Orthogonal };
    Projection projection = Perspective;
    float fov = 70.0f;
    float nearPlane = 0.05f, farPlane = 4000.0f;

    void makeCurrent();
    bool isCurrent() const;
};

class NamedCamera : public core::Named<Camera> {
public:
    int priority = 0;
};

namespace detail {
class CameraController {
public:
    virtual ~CameraController() = default;
    virtual void update(Camera& cam, float dt) = 0;
};
} // namespace detail

class OrbitCameraController : public detail::CameraController {
public:
    void update(Camera& cam, float dt) override;
    float distance = 5.0f;
};

} // namespace scene
