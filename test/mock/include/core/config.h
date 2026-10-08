#pragma once
// Project-wide macros. Some headers are pulled in through these macros,
// which a naive text scan of #include lines cannot see.

#define ENGINE_STRINGIFY_(x) #x
#define ENGINE_STRINGIFY(x) ENGINE_STRINGIFY_(x)
#define CORE_HEADER(name) <core/name.h>
#define SCENE_HEADER(name) <scene/name.h>
#define RENDER_BACKEND_HEADER "render/gl_renderer.h"

// Declares a component class deriving from a base, hiding the inheritance.
#define DECLARE_COMPONENT(Name, Base) \
    class Name : public Base

#define ENGINE_API

#ifndef ENGINE_USE_VULKAN
#define ENGINE_USE_VULKAN 1
#endif
