#pragma once
// Exercises UML relationships other than inheritance.
#include "scene/node.h"
#include "scene/camera.h"
#include "scene/light.h"
#include "render/renderer.h"
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace scene {

/// Pure interface: SceneTree *realizes* it.
class ISceneVisitor {
public:
    virtual ~ISceneVisitor() = default;
    virtual void visit(Node& node) = 0;
    virtual bool wantsChildren(const Node& node) const = 0;
};

struct SceneStats {
    int nodeCount = 0;
    int drawCalls = 0;
};

class SceneTree : public core::RefCounted, public ISceneVisitor {
public:
    // dependency: Light and Spatial are only used in method signatures
    Node* findByName(const std::string& name) const;
    void addLight(std::unique_ptr<Light> light);
    std::vector<Spatial*> collectVisible(const Camera& from) const;

    void visit(Node& node) override;
    bool wantsChildren(const Node& node) const override;

private:
    std::unique_ptr<Node> m_root;                       // composition 0..1
    SceneStats m_stats;                                 // composition 1
    std::optional<Transform> m_origin;                  // composition 0..1
    std::vector<std::shared_ptr<Camera>> m_cameras;     // aggregation *
    std::map<std::string, Node*> m_index;               // aggregation *
    std::weak_ptr<Light> m_sun;                         // association 0..1
    render::Renderer* m_renderer = nullptr;             // association 0..1
};

} // namespace scene
