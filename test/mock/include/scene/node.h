#pragma once
#include "core/config.h"
#include CORE_HEADER(refcounted)
#include CORE_HEADER(observable)
#include "scene/mixins/serializable.h"
#include <string>
#include <vector>

namespace scene {

class Node : public core::RefCounted,
             public core::Observable<Node>,
             public mixins::ISerializable {
public:
    Node* parent() const { return m_parent; }
    const std::vector<Node*>& children() const { return m_children; }
    void addChild(Node* child);

    std::string serialize() const override;
    void deserialize(const std::string& data) override;

    std::string name;

private:
    Node* m_parent = nullptr;
    std::vector<Node*> m_children;
};

} // namespace scene
