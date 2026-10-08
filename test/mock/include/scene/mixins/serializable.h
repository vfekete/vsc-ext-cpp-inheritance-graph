#pragma once
#include <string>

namespace scene::mixins {

struct ISerializable {
    virtual ~ISerializable() = default;
    virtual std::string serialize() const = 0;
    virtual void deserialize(const std::string& data) = 0;
};

class Skinnable {
public:
    void setSkeleton(int skeletonId) { m_skeleton = skeletonId; }
    int skeleton() const { return m_skeleton; }
protected:
    int m_skeleton = -1;
};

} // namespace scene::mixins
