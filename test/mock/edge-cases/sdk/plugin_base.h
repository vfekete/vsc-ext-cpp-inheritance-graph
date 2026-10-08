#pragma once

namespace sdk {

class PluginBase {
public:
    virtual ~PluginBase() = default;
    virtual const char* pluginName() const = 0;
};

} // namespace sdk
