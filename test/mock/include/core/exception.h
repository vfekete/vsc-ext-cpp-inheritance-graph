#pragma once
#include <stdexcept>
#include <string>

namespace core {

class CoreError : public std::runtime_error {
public:
    explicit CoreError(const std::string& msg) : std::runtime_error(msg) {}
    int code = 0;
};

class ResourceError : public CoreError {
public:
    using CoreError::CoreError;
    std::string resourcePath;
};

class ShaderCompileError final : public ResourceError {
public:
    using ResourceError::ResourceError;
    int line = 0;
    int column = 0;
};

} // namespace core
